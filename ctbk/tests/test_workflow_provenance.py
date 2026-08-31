"""The create/ADD workflow must record provenance (cmd + deps), not just outs.

Regression guard for the "recorder gap": `ctbk <stage> create` (CI's monthly
driver via `ctbk update`) recorded .dvc files through a bare `dvx add` — outs
only, no `meta.computation`. Every CI-added month therefore lacked the cmd/deps
that `batch/reproc-targets` requires to include a stage in a from-scratch
reproc, silently shrinking audit coverage (~8 stages/month). The fix routes the
ADD level through the same `Artifact.write_dvc()` recorder the `prep` and `run`
paths use, given the stage's artifacts.

`run_workflow` keeps a legacy no-`artifacts` path (bare `dvx add`, provenance-
blind); the second test pins that contrast so a future refactor can't silently
reintroduce the gap for the create path.
"""
from pathlib import Path

from ruamel.yaml import YAML

from ctbk.cli.workflow import Workflow, run_workflow
from dvx.run.artifact import Artifact, Computation


def _load(dvc_path: Path) -> dict:
    yaml = YAML()
    with open(dvc_path) as f:
        return yaml.load(f)


def test_add_with_artifacts_records_cmd_and_deps(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)  # same-dir deps → bare-relative form in the .dvc
    dep = Path("in.parquet")
    dep.write_bytes(b"input-bytes")
    out = Path("out.parquet")
    out.write_bytes(b"output-bytes")

    dep_art = Artifact.from_path(dep)
    art = Artifact(
        path=str(out),
        computation=Computation(cmd="ctbk demo create -w0 202506", deps=[dep_art]),
    )

    run_workflow([str(out)], Workflow.ADD, artifacts=[art])

    spec = _load(Path("out.parquet.dvc"))
    assert spec["outs"][0]["md5"] == Artifact.from_path(out).md5
    assert spec["meta"]["computation"]["cmd"] == "ctbk demo create -w0 202506"
    assert spec["meta"]["computation"]["deps"] == {"in.parquet": dep_art.md5}


def test_add_without_artifacts_is_provenance_blind(tmp_path, monkeypatch):
    """The legacy path (no artifacts) records outs but NOT provenance — the gap
    the create path used to sit on. Uses `dvx add`, so run inside a dvx repo."""
    from utz import proc

    monkeypatch.chdir(tmp_path)
    proc.run("git", "init", "-q")
    proc.run("dvx", "init")
    out = Path("out.parquet")
    out.write_bytes(b"output-bytes")

    run_workflow([str(out)], Workflow.ADD)  # no artifacts → bare `dvx add`

    spec = _load(Path("out.parquet.dvc"))
    assert "md5" in spec["outs"][0]
    assert "meta" not in spec or "computation" not in (spec.get("meta") or {})
