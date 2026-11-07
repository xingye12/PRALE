"""Parse OS-observed readable file opens; never infer access from shell text."""

import json
import re
from pathlib import Path


def opened_files(trace: str, workspace: Path) -> list[str]:
    found = set()
    pending: dict[str, str] = {}
    for line in trace.splitlines():
        parts = line.split(None, 1)
        pid = parts[0] if len(parts) == 2 and parts[0].isdigit() else "main"
        if "<unfinished ...>" in line:
            pending[pid] = line.split("<unfinished ...>", 1)[0]
            continue
        if "resumed>" in line:
            prefix = pending.pop(pid, "")
            if not prefix:
                continue
            line = prefix + line.split("resumed>", 1)[1]
        if not re.search(r"\bopen(?:at2|at)?\(", line) or not re.search(r"\bO_(?:RDONLY|RDWR)\b", line):
            continue
        match = re.search(r"=\s*\d+<(/workspace/[^>]*)>", line)
        if not match:
            continue
        raw = match.group(1)[len("/workspace/") :]
        # strace C string escaping also occurs in decoded fd paths.
        try:
            raw = json.loads('"' + raw + '"') if "\\" in raw else raw
        except ValueError:
            continue
        candidate = workspace / raw
        try:
            relative = candidate.resolve().relative_to(workspace.resolve())
        except ValueError:
            continue
        if not candidate.is_dir() and "O_DIRECTORY" not in line:
            found.add(relative.as_posix())
    return sorted(found)
