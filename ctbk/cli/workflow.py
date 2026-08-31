"""Workflow levels for ctbk pipeline commands.

Defines escalating levels of post-computation operations:
- Level 0 (COMPUTE): Just run the computation
- Level 1 (ADD): + dvx add (compute hash, update .dvc file)
- Level 2 (COMMIT): + git add + git commit
- Level 3 (PUSH): + dvc push
- Level 4 (FULL): + git push

Dependencies:
    compute → dvx add → git add → git commit ─┬→ git push
                                              │
                                  dvc push ───┘
"""

from enum import IntEnum
from click import option


class Workflow(IntEnum):
    """Workflow levels for post-computation operations."""
    COMPUTE = 0  # Just compute
    ADD = 1      # + dvx add (update .dvc with hash)
    COMMIT = 2   # + git add + commit
    PUSH = 3     # + dvc push
    FULL = 4     # + git push

    @classmethod
    def from_value(cls, value: int | str | None) -> "Workflow":
        """Convert int or string to Workflow level."""
        if value is None:
            return cls.ADD  # Default
        if isinstance(value, cls):
            return value
        if isinstance(value, int):
            return cls(value)
        # String name lookup
        name = value.upper()
        if hasattr(cls, name):
            return cls[name]
        raise ValueError(f"Unknown workflow level: {value}")


# Shared click option for workflow level
WORKFLOW_HELP = """\
Workflow level (0-4):
  0/compute: just run computation
  1/add: + update .dvc file with hash (default)
  2/commit: + git add + commit
  3/push: + dvc push
  4/full: + git push
"""

workflow_option = option(
    '-w', '--workflow',
    type=int,
    default=1,
    help=WORKFLOW_HELP,
)


def run_workflow(
    paths: list[str],
    workflow: int | Workflow,
    commit_msg: str | None = None,
    artifacts: "list | None" = None,
):
    """Execute post-computation workflow steps.

    Args:
        paths: List of output paths (data files, not .dvc files)
        workflow: Workflow level to execute
        commit_msg: Git commit message (required for level >= COMMIT)
        artifacts: Optional `dvx.run.artifact.Artifact`s carrying each output's
            `Computation` (cmd + deps). When given, the ADD level records
            provenance via the same `Artifact.write_dvc()` recorder the `prep`
            and `run` paths use — so `create`-path .dvc files carry
            `meta.computation` and stay reproc-eligible. Without it (legacy
            callers), the ADD level falls back to a bare `dvx add` that records
            outs only (the provenance gap that left CI-added months un-reproc-able).
    """
    from pathlib import Path
    from utz import run, err

    level = Workflow.from_value(workflow)

    if level < Workflow.ADD:
        return  # Nothing to do

    # Level 1+: record each output's .dvc (hash + provenance).
    if artifacts is not None:
        for artifact in artifacts:
            if Path(artifact.path).exists():
                artifact.write_dvc()
                err(f"Recorded {artifact.path} (+ provenance)")
            else:
                err(f"Warning: {artifact.path} does not exist, skipping")
        paths = [a.path for a in artifacts]
    else:
        # Legacy path: bare `dvx add` (outs only, no meta.computation).
        for path in paths:
            p = Path(path)
            if p.exists():
                run('dvx', 'add', str(p))
                err(f"Added {p}")
            else:
                err(f"Warning: {path} does not exist, skipping dvx add")

    if level < Workflow.COMMIT:
        return

    # Level 2+: git add + commit
    dvc_files = [f"{p}.dvc" for p in paths]
    run('git', 'add', *dvc_files)

    if commit_msg:
        run('git', 'commit', '-m', commit_msg)
    else:
        err("Warning: no commit message provided, skipping git commit")

    if level < Workflow.PUSH:
        return

    # Level 3+: dvc push
    run('dvc', 'push', *paths)

    if level < Workflow.FULL:
        return

    # Level 4: git push
    run('git', 'push')
