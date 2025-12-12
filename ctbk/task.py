from abc import ABC
from os.path import join
from pathlib import Path
from typing import TYPE_CHECKING, TypeVar, Generic

from utz import err

from ctbk.has_url import HasURL
from ctbk.paths import S3

if TYPE_CHECKING:
    from dvx.run.artifact import Artifact, Computation

T = TypeVar("T")


class Task(HasURL, ABC, Generic[T]):
    DIR = None
    NAMES = []

    def __init__(self):
        HasURL.__init__(self)

    def _create(self) -> T | None:
        raise NotImplementedError

    def create(self) -> T:
        url = self.url
        err(f'Writing {url}')
        return self._create()

    def read(self) -> T:
        raise NotImplementedError

    @property
    def dir(self) -> str:
        assert self.DIR
        return join(S3, self.DIR)

    # DVX integration methods

    def deps(self) -> list["Task"]:
        """Return upstream Task dependencies.

        Override in subclasses to specify what this task depends on.
        Default is no dependencies (leaf node).
        """
        return []

    @property
    def cmd(self) -> str | None:
        """CLI command that produces this artifact.

        Override in subclasses to specify the command.
        Default is None (leaf node / imported data).
        """
        return None

    def dep_artifacts(self) -> list["Artifact"]:
        """Return dependency artifacts for this task.

        Override in subclasses that have non-Task dependencies (e.g., DvcBlob).
        Default implementation converts deps() tasks to artifacts.
        """
        return [dep.to_artifact() for dep in self.deps()]

    def to_artifact(self) -> "Artifact":
        """Convert this Task to a DVX Artifact with computation info.

        Returns:
            Artifact with path, computation (if cmd is set), and optional hash/size
        """
        from dvx.run.artifact import Artifact, Computation

        path = Path(self.url)
        cmd = self.cmd
        dep_artifacts = self.dep_artifacts()

        if cmd and dep_artifacts:
            # Computed artifact with dependencies
            computation = Computation(cmd=cmd, deps=dep_artifacts)
            return Artifact(path=path, computation=computation)
        elif cmd:
            # Computed artifact with no deps (unusual but possible)
            computation = Computation(cmd=cmd)
            return Artifact(path=path, computation=computation)
        else:
            # Leaf node - just return artifact from existing .dvc file if possible
            return Artifact.from_dvc(path) or Artifact(path=path)
