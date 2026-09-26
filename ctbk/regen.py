"""`ctbk regen`: regenerate trips-DAG outputs on AWS Batch (HCCS `ctbk-reproc`
queue), noninteractively — specs/batch-pipeline.md.

Two job shapes, both via `batch/entrypoint.sh` in the `ctbk-reproc` image:

- **DVX stages** (default): `dvx run --no-commit --push each --remote r2 -f`
  over a month/family-scoped target set, expanded in-container by
  `batch/regen-targets` (the path list overflows Batch's 8 KB override cap).
  Upstream `norm` / `v0` outputs are pinned with `--cached` so a forced
  partial regen re-derives from them instead of re-reading `s3://tripdata`.
- **Script** (`-s`): a shell snippet of `ctbk` commands for steps that aren't
  `dvx run`-able (whole-history `station-harmonize`, the provenance-less
  `ymrgtb{s,e}_cd` aggregates), then `dvx push -r r2`.

Either way the job pushes its changed tracked files as one commit to
`regen-results/<ts>` (review + merge; nothing is live until then — the R2
cache is content-addressed). The container runs the code baked into the job
definition's image (`reproc_image` in the `hccs` Pulumi stack), not the local
checkout: rebuild + bump it after code changes.
"""
import shlex

from click import option
from utz import err
from utz.cli import flag

from ctbk.cli.base import ctbk

PREFIX = 'ctbk-reproc'
REGION = 'us-east-1'
# `batch/regen-targets` default excludes `norm`/`v0`; pin them against `-f`.
PIN_UPSTREAM = ('s3/ctbk/normalized/??????', 's3/ctbk/normalized/v0/*')


def job_env(
    months: str | None,
    families: tuple[str, ...],
    pin_upstream: bool,
    results_prefix: str,
    base_ref: str | None = None,
) -> dict[str, str]:
    """Container env for a regen job (the entrypoint's `$REGEN_TARGETS` /
    `$DVX_CACHED` / `$RESULTS_PREFIX` / `$BASE_REF` contract)."""
    env = {'RESULTS_PREFIX': results_prefix}
    if base_ref:
        env['BASE_REF'] = base_ref
    targets = []
    if months:
        targets += ['-m', months]
    for f in families:
        targets += ['-f', f]
    if targets:
        env['REGEN_TARGETS'] = shlex.join(targets)
    if pin_upstream:
        env['DVX_CACHED'] = ' '.join(PIN_UPSTREAM)
    return env


def job_command(
    script: str | None,
    force: bool,
    jobs: int | None,
) -> list[str]:
    if script:
        return ['script', script]
    from dvx.batch import run_command
    return run_command(force=force, jobs=jobs, commit='never', push='each', remote='r2')


@ctbk.command('regen')
@option('-b', '--base-ref', help="Start from this branch's `s3/` data pointers (chain onto an earlier job's `regen-results/<ts>` branch).")
@option('-f', '--family', 'families', multiple=True, help='`batch/regen-targets` family (repeatable; default: all but norm/v0). Ignored with -s.')
@flag('-F', '--no-force', help="Don't `dvx run -f` (only stale targets re-run).")
@option('-j', '--jobs', type=int, help='`dvx run -j` (default: the job\'s vCPUs).')
@option('-m', '--months', help='Months to regen: `YYYYMM` / `YYYYMM-YYYYMM`, comma-separated (default: all).')
@option('-n', '--job-name', help='Batch job name (default: `regen-<months|script>`).')
@flag('-N', '--dry-run', help='Print the job (command + env) without submitting.')
@flag('-P', '--no-pin-upstream', help='Also re-run upstream `norm`/`v0` stages (re-reads s3://tripdata).')
@option('-r', '--results-prefix', default='regen-results', show_default=True, help='Push-back branch prefix.')
@option('-s', '--script', help='Run this shell snippet (in the repo clone) instead of `dvx run`, then `dvx push -r r2`.')
@option('-V', '--vcpus', type=int, help='Override job vCPUs (job def: 16).')
@flag('-w', '--watch', help='Tail the job log; exit with its status.')
def regen(
    base_ref: str | None,
    families: tuple[str, ...],
    no_force: bool,
    jobs: int | None,
    months: str | None,
    job_name: str | None,
    dry_run: bool,
    no_pin_upstream: bool,
    results_prefix: str,
    script: str | None,
    vcpus: int | None,
    watch: bool,
):
    """Submit a trips-DAG regen job to AWS Batch (`ctbk-reproc`)."""
    env = job_env(
        months,
        () if script else families,
        pin_upstream=not no_pin_upstream and not script,
        results_prefix=results_prefix,
        base_ref=base_ref,
    )
    command = job_command(script, force=not no_force, jobs=jobs)
    name = job_name or ('regen-script' if script else f'regen-{months or "all"}')
    # Batch job names: letters, numbers, hyphens, underscores; ≤128.
    name = ''.join(c if c.isalnum() or c in '-_' else '-' for c in name)[:128]
    err(f'job {name}: {shlex.join(command)}')
    for k, v in env.items():
        err(f'  {k}={v}')
    if dry_run:
        return
    import boto3  # noqa: F401 — fail fast with a clear ImportError before dvx's lazy import
    from dvx.batch import submit
    rc = submit(
        command=command,
        job_name=name,
        prefix=PREFIX,
        vcpus=vcpus,
        environment=env,
        watch=watch,
    )
    if rc:
        raise SystemExit(rc)
