"""Controller-owned workspace fingerprints independent of the submitted Git index."""

import hashlib
import json
import os
from pathlib import Path


def _files(workspace: Path) -> dict[str, dict[str, str]]:
    """Fingerprint actual files/symlinks; an agent-controlled index is not evidence."""
    result = {}
    for directory, directories, filenames in os.walk(workspace, followlinks=False):
        if Path(directory) == workspace:
            directories[:] = [name for name in directories if name != ".git"]
        for name in [*directories, *filenames]:
            path = Path(directory) / name
            relative = path.relative_to(workspace).as_posix()
            if path.is_symlink():
                result[relative] = {"kind": "symlink", "target": os.readlink(path)}
            elif path.is_file():
                result[relative] = {
                    "kind": "file",
                    "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                    "mode": str(path.stat().st_mode & 0o777),
                }
    return result


def capture_manifest(workspace: Path, manifest_path: Path, baseline: str) -> None:
    """Called by the controller before any agent code runs, outside the workspace."""
    if manifest_path.resolve().is_relative_to(workspace.resolve()):
        raise ValueError("controller baseline must be outside the agent workspace")
    manifest = {
        "baseline_commit": baseline,
        "files": _files(workspace),
        "git_config_sha256": hashlib.sha256((workspace / ".git/config").read_bytes()).hexdigest(),
    }
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, sort_keys=True) + "\n", encoding="utf-8")
