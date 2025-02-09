from os import environ as env

import click
from click import pass_context, option, group, Context, Command
from typing import Tuple, Optional, List
from utz import o, DefaultDict, err, is_subsequence

from ctbk.has_root import DEFAULT_ROOTS, ROOTS_ENV_VAR
from ctbk.util import write, read
from ctbk.util.constants import S3
from ctbk.util.read import Disk
from ctbk.util.write import IfAbsent


class StableCommandOrder(click.Group):
    def list_commands(self, ctx: Context) -> List[str]:
        # Don't sort commands, print them in the order they're registered (see ctbk/__init__.py)
        return list(self.commands.keys())


class Ctbk(StableCommandOrder):
    def get_command(self, ctx: Context, cmd_name: str) -> Optional[Command]:
        command = super().get_command(ctx, cmd_name)
        if command:
            return command

        commands = self.commands
        prefix_cmds = [ name for name in commands if name.startswith(cmd_name) ]
        if len(prefix_cmds) == 1:
            return commands[prefix_cmds[0]]

        for command in commands.values():
            aliases = getattr(command, 'ALIASES', None)
            if aliases and cmd_name in aliases:
                return command

        if len(prefix_cmds) > 1:
            prefix_cmds_str = '\n\t'.join(prefix_cmds)
            err(f"{len(prefix_cmds)} commands found beginning with `{cmd_name}`:\n\t{prefix_cmds_str}\n")
            return None

        subseq_cmds = [ name for name in commands if is_subsequence(cmd_name, name) ]
        if len(subseq_cmds) == 1:
            return commands[subseq_cmds[0]]

        elif len(subseq_cmds) > 1:
            subseq_cmds_str = '\n\t'.join(subseq_cmds)
            err(f"No commands found beginning with `{cmd_name}`, and {len(subseq_cmds)} subsequence matches:\n\t{subseq_cmds_str}\n")
        else:
            cmds_str = '\n\t'.join(commands)
            err(f"No prefix or subsequence matches for `{cmd_name}`:\n\t{cmds_str}\n")
        return None

    def get_help(self, ctx):
        orig_wrap_text = click.formatting.wrap_text

        def wrap_text(text, width=78, initial_indent='',
                      subsequent_indent='',
                      preserve_paragraphs=False):
            return (
                orig_wrap_text(
                    # text,
                    text.replace('\n', '\n\n'),
                    width=92,
                    initial_indent=initial_indent,
                    subsequent_indent=subsequent_indent,
                    preserve_paragraphs=True
                )
                .replace('\n\n', '\n')
            )

        click.formatting.wrap_text = wrap_text
        return super().get_help(ctx)


def load_roots(roots: Tuple[str, ...]):
    if roots:
        roots = DefaultDict.load(roots)
        return DefaultDict(
            configs={ **DEFAULT_ROOTS.configs, **roots.configs },
            default=roots.default or DEFAULT_ROOTS.default,
        )
    else:
        roots_str = env.get(ROOTS_ENV_VAR)
        if not roots_str:
            return DEFAULT_ROOTS
        roots = DefaultDict.load(roots_str.split(','))
        return DefaultDict(
            configs={ **DEFAULT_ROOTS.configs, **roots.configs },
            default=roots.default or DEFAULT_ROOTS.default,
        )


roots_opt = option('-t', '--root', 'roots', multiple=True, help='Path- or URL-prefixes for `HasRoot` subclasses to write to and read from. `<alias>=<value>` to set specific classes by alias, just `<value>` to set a global default. `<value>`s are `memory`, `disk`, and their aliases, indicating whether to return disk-round-tripped versions of newly-computed datasets.')


@group('ctbk', cls=Ctbk, help="""
CLI for generating ctbk.dev datasets (derived from Citi Bike public data in `s3://`).

## Data flow

### `TripdataZips` (a.k.a. `zip`s): Public Citi Bike `.csv.zip` files
- Released as NYC and JC `.csv.zip` files at s3://tripdata
- See https://tripdata.s3.amazonaws.com/index.html

### `TripdataCsvs` (a.k.a. `csv`s): unzipped and gzipped CSVs
- Writes `<root>/ctbk/csvs/YYYYMM.csv`
- See also: https://ctbk.s3.amazonaws.com/index.html#/csvs

### `NormalizedMonths` (a.k.a. `norm`s): normalize `csv`s
- Merge regions (NYC, JC) for the same month, harmonize columns drop duplicate data, etc.
- Writes `<root>/ctbk/normalized/YYYYMM.parquet`
- See also: https://ctbk.s3.amazonaws.com/index.html#/normalized

### `AggregatedMonths` (a.k.a. `agg`s): compute histograms over each month's rides:
- Group by any of several \"aggregation keys\" ({year, month, day, hour, user type, bike 
  type, start and end station, …}) 
- Produce any \"sum keys\" ({ride counts, duration in seconds})
- Writes `<root>/ctbk/aggregated/KEYS_YYYYMM.parquet`
- See also: https://ctbk.s3.amazonaws.com/index.html#/aggregated?p=8

### `StationMetaHists` (a.k.a. `smh`s): compute station {id,name,lat/lng} histograms:
- Similar to `agg`s, but counts station {id,name,lat/lng} tuples that appear as each 
  ride's start and end stations (whereas `agg`'s rows are 1:1 with rides)
- "agg_keys" can include id (i), name (n), and lat/lng (l); there are no "sum_keys" 
  (only counting is supported)
- Writes `<root>/ctbk/stations/meta_hists/YYYYMM/KEYS.parquet`
- See also: https://ctbk.s3.amazonaws.com/index.html#/stations/meta_hists

### `StationModes` (a.k.a. `sm`s): canonical {id,name,lat/lng} info for each station:
- Computed from `StationMetaHist`s:
  - `name` is chosen as the "mode" (most commonly listed name for that station ID)
  - `lat/lng` is taken to be the mean of the lat/lngs reported for each ride's start 
    and end station
- Writes `<root>/ctbk/aggregated/YYYYMM/stations.json`
- See also: https://ctbk.s3.amazonaws.com/index.html#/aggregated

### `StationPairJsons` (a.k.a. `spj`s): counts of rides between each pair of stations:
- JSON formatted as `{ <start idx>: { <end idx>: <count> } }`
- `idx`s are based on order of appearance in `StationModes` / `stations.json` above
  (which is also sorted by station ID)
- Values are read from `AggregatedMonths(YYYYMM, 'se', 'c')`:
  - group by station start ("s") and end ("e"),
  - sum ride counts ("c")
- Writes `<root>/ctbk/aggregated/YYYYMM/se_c.json`
- See also: https://ctbk.s3.amazonaws.com/index.html#/aggregated
""")
@pass_context
@option('-r', '--read', 'reads', multiple=True, help='Set "read" behavior for `HasRoot` subclasses, `<alias>=<value>` to set specific classes by alias, just `<value>` to set a global default. `<value>`s are `memory`, `disk`, and their aliases, indicating whether to return disk-round-tripped versions of newly-computed datasets.')
@roots_opt
@option('-w', '--write', 'writes', multiple=True, help='Set "write" behavior for `HasRoot` subclasses, `<alias>=<value>` to set specific classes by alias, just `<value>` to set a global default. `<value>`s are `never`, `ifabsent`, `always`, and their aliases, indicating how to handle each dataset type already existing on disk (under its `root`) vs. not.')
@option('--s3', is_flag=True, help="Alias for `--root s3:/`, pointing all classes' \"root\" dirs at S3")
def ctbk(ctx, reads, roots, writes, s3):
    if s3:
        roots = [S3] + (list(roots) or [])

    roots = load_roots(roots)
    reads = DefaultDict.load(reads, name2value=read.parse, fallback=Disk)
    writes = DefaultDict.load(writes, name2value=write.parse, fallback=IfAbsent)
    ctx.obj = o(roots=roots, reads=reads, writes=writes)
