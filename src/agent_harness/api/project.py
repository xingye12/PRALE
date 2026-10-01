"""Server-owned deployment configuration.

Nothing here is ever derived from a browser request: the project root, the
repository identity and every database location are fixed at startup so that a
client can only ever name a session, never a path.
"""

import re
from dataclasses import dataclass
from pathlib import Path

from agent_harness.api.errors import ProjectConfigError

_ABSOLUTE_PATH = re.compile(r"^(?:/|[A-Za-z]:[\\/]|\\\\)")


@dataclass(frozen=True, slots=True)
class ProjectInfo:
    """The only project data a client may see: no filesystem layout leaks."""

    project_root: str
    repository_id: str
    project_id: str


@dataclass(frozen=True, slots=True)
class ProjectRuntimeConfig:
    """One deployment: a project root, its repository identity, and its stores."""

    project_root: Path
    repository_id: str
    sessions_dir: Path
    catalog_db: Path
    memory_db: Path | None = None
    memory_assets_dir: Path | None = None
    skill_db: Path | None = None
    project_id: str | None = None
    default_lane: str = "main"

    def __post_init__(self) -> None:
        root = Path(self.project_root)
        try:
            resolved = root.resolve(strict=True)
        except OSError as error:
            raise ProjectConfigError(f"project_root does not exist: {root}") from error
        if not resolved.is_dir():
            raise ProjectConfigError(f"project_root is not a directory: {resolved}")
        if not self.repository_id or "\x00" in self.repository_id:
            raise ProjectConfigError("repository_id must be non-empty and contain no NUL")
        if _ABSOLUTE_PATH.match(self.repository_id):
            # ADR-018: a checkout path is ephemeral, so it can never be the
            # identity that L0--L2 memory and skills are owned by.
            raise ProjectConfigError(
                "repository_id must be a stable identifier (for example a canonical Git remote), not a filesystem path"
            )
        if not self.default_lane or "\x00" in self.default_lane:
            raise ProjectConfigError("default_lane must be non-empty and contain no NUL")
        object.__setattr__(self, "project_root", resolved)
        object.__setattr__(self, "sessions_dir", Path(self.sessions_dir))
        object.__setattr__(self, "catalog_db", Path(self.catalog_db))
        object.__setattr__(self, "memory_db", None if self.memory_db is None else Path(self.memory_db))
        object.__setattr__(
            self, "memory_assets_dir", None if self.memory_assets_dir is None else Path(self.memory_assets_dir)
        )
        object.__setattr__(self, "skill_db", None if self.skill_db is None else Path(self.skill_db))

    @property
    def project(self) -> ProjectInfo:
        return ProjectInfo(str(self.project_root), self.repository_id, self.project_id or self.repository_id)
