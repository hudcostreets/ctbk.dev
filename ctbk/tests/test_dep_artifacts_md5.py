"""`sm`/`spj` must record dep md5s even when the dep outputs aren't local.

The `create` path records deps via `get_dep_hashes()`, which keeps an
`Artifact` dep only if its md5 is set OR its file is on disk. `sm`/`spj` built
their deps with a bare `dep.to_artifact()` (md5=None) — fine at create time
(the just-built outputs are local, so md5 hashes from disk), but in a
provenance *backfill* (outputs live only in the cache/remote) every dep was
silently dropped, leaving `.dvc`s with no ordering edges for a reproc. The fix
loads each dep's md5 from its committed `.dvc` (`Artifact.from_dvc`), matching
`agg`/`norm`. These deps are files (no `.dir`), so `from_dvc`'s hash is exact.
"""
from pathlib import Path

from dvx.run.dvc_files import write_dvc_file

from ctbk.aggregated import AggregatedMonth
from ctbk.stations.meta_hists import StationMetaHist
from ctbk.stations.modes import ModesMonthJson
from ctbk.stations.pair_jsons import StationPairsJson


def _write_dep_dvcs(deps: dict[str, str]) -> None:
    """Create a committed-style `.dvc` (md5 present, output file absent) per dep."""
    for url, md5 in deps.items():
        Path(url).parent.mkdir(parents=True, exist_ok=True)
        write_dvc_file(output_path=Path(url), md5=md5, size=1)


def test_sm_dep_artifacts_carry_md5_when_outputs_absent(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    ym = 202512
    deps = {
        StationMetaHist(ym, "in").url: "a" * 32,
        StationMetaHist(ym, "il").url: "b" * 32,
        AggregatedMonth(ym, "e", "c").url: "c" * 32,
    }
    _write_dep_dvcs(deps)

    got = {a.path: a.md5 for a in ModesMonthJson(ym).dep_artifacts()}
    assert got == deps


def test_spj_dep_artifacts_carry_md5_when_outputs_absent(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    ym = 202512
    deps = {
        ModesMonthJson(ym).url: "d" * 32,
        AggregatedMonth(ym, "se", "c").url: "e" * 32,
    }
    _write_dep_dvcs(deps)

    got = {a.path: a.md5 for a in StationPairsJson(ym).dep_artifacts()}
    assert got == deps
