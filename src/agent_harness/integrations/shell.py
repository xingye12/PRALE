"""Injectable Linux workspace sandbox planning and process launch boundary."""

import asyncio
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol


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
    version: str = "bwrap-workspace-v1"

    def _wrapper(self, cwd: Path) -> tuple[str, ...]:
        executable = shutil.which("bwrap")
        if executable is None:
            raise OSError("bubblewrap is not installed")
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
            identity = f"{self.version}:{executable.resolve()}:{executable.stat().st_mtime_ns}"
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
