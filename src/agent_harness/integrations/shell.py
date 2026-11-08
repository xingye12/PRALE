"""Injectable Linux workspace sandbox planning and process launch boundary."""

import asyncio
import hashlib
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

READONLY_WORKSPACE_PATHS = (
    ".bashrc",
    ".bash_profile",
    ".zshrc",
    ".zprofile",
    ".profile",
    ".gitconfig",
    ".gitmodules",
    ".ripgreprc",
    ".mcp.json",
    ".vscode",
    ".idea",
    ".git/hooks",
    ".git/config",
)


@dataclass(frozen=True)
class ShellCapability:
    available: bool
    identity: str
    reason: str = ""


class ShellExecutor(Protocol):
    def probe(self, cwd: Path) -> ShellCapability: ...

    async def launch(
        self, argv: tuple[str, ...], cwd: Path, env: dict[str, str], sandbox: bool
    ) -> asyncio.subprocess.Process: ...


@dataclass(frozen=True)
class BubblewrapExecutor:
    version: str = "bwrap-workspace-v2"

    def _readonly_mounts(self, cwd: Path) -> tuple[tuple[Path, Path], ...]:
        paths = [cwd / name for name in READONLY_WORKSPACE_PATHS]
        if (cwd / ".git").is_file():
            paths.append(cwd / ".git")
        mounts: list[tuple[Path, Path]] = []
        for path in paths:
            if path.exists():
                resolved = path.resolve(strict=True)
                # Mount the canonical target: bwrap rejects symlink destinations.
                pair = (resolved, resolved)
                if pair not in mounts:
                    mounts.append(pair)
        return tuple(mounts)

    def _wrapper(self, cwd: Path) -> tuple[str, ...]:
        executable = shutil.which("bwrap")
        if executable is None:
            raise OSError("bubblewrap is not installed")
        readonly = tuple(
            argument
            for source, target in self._readonly_mounts(cwd)
            for argument in ("--ro-bind", str(source), str(target))
        )
        return (
            executable,
            "--die-with-parent",
            "--unshare-user",
            "--unshare-pid",
            "--cap-drop",
            "ALL",
            "--ro-bind",
            "/",
            "/",
            "--dev",
            "/dev",
            "--proc",
            "/proc",
            "--tmpfs",
            "/tmp",
            "--bind",
            str(cwd),
            str(cwd),
            *readonly,
            "--chdir",
            str(cwd),
            "--",
        )

    def probe(self, cwd: Path) -> ShellCapability:
        if sys.platform != "linux":
            return ShellCapability(False, self.version, "platform does not support Linux bubblewrap")
        # /tmp itself (or an ancestor of it) cannot be both private and workspace-writable.
        if cwd in {Path("/"), Path("/tmp")} or any(cwd.is_relative_to(p) for p in (Path("/dev"), Path("/proc"))):
            return ShellCapability(False, self.version, "workspace overlaps sandbox system mounts")
        try:
            wrapper = self._wrapper(cwd)
            executable = Path(wrapper[0])
            mount_identity = tuple(
                (str(source), str(target), source.stat().st_dev, source.stat().st_ino)
                for source, target in self._readonly_mounts(cwd)
            )
            digest = hashlib.sha256(repr(mount_identity).encode()).hexdigest()
            identity = f"{self.version}:{executable.resolve()}:{executable.stat().st_mtime_ns}:{digest}"
            result = subprocess.run(
                (*wrapper, "/bin/true"),
                capture_output=True,
                timeout=3,
                check=False,
            )
            if result.returncode:
                return ShellCapability(False, identity, "bubblewrap namespace probe failed")
            return ShellCapability(True, identity)
        except (OSError, subprocess.TimeoutExpired) as exc:
            return ShellCapability(False, self.version, f"bubblewrap unavailable: {type(exc).__name__}")

    async def launch(
        self, argv: tuple[str, ...], cwd: Path, env: dict[str, str], sandbox: bool
    ) -> asyncio.subprocess.Process:
        if sandbox:
            argv = (*self._wrapper(cwd), *argv)
            env = {**env, "TMPDIR": "/tmp", "TMP": "/tmp", "TEMP": "/tmp"}
        return await asyncio.create_subprocess_exec(
            *argv,
            cwd=str(cwd),
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=os.name != "nt",
        )
