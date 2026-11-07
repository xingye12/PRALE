from pathlib import Path

from bash_file_access import opened_files
from repository_explore_scoring import FileAccessCollector, score_output

from agent_harness.runtime.telemetry import ToolTelemetry


def test_readable_successful_file_opens_exclude_directories_writes_and_failures(tmp_path: Path) -> None:
    (tmp_path / "a.py").write_text("x")
    trace = """1 openat(AT_FDCWD, "a.py", O_RDONLY) = 3</workspace/a.py>
1 openat(AT_FDCWD, "a.py", O_RDONLY) = 3</workspace/a.py>
1 openat(AT_FDCWD, ".", O_RDONLY|O_DIRECTORY) = 3</workspace>
1 openat(AT_FDCWD, "a.py", O_WRONLY|O_TRUNC) = 3</workspace/a.py>
1 openat(AT_FDCWD, "missing", O_RDONLY) = -1 ENOENT
1 openat(AT_FDCWD, "/etc/passwd", O_RDONLY) = 3</etc/passwd>
"""
    assert opened_files(trace, tmp_path) == ["a.py"]


def test_bash_and_read_union_is_deduplicated_and_scored_separately_from_explorer(tmp_path: Path) -> None:
    c = FileAccessCollector(tmp_path)
    c.register_bash("cat a.py", {"complete": True, "files": ["a.py", "extra.py"]})
    for name, args in [("bash", {"command": "cat a.py"}), ("read", {"path": "a.py"})]:
        c.record(ToolTelemetry("s", "main", "op", name, name, 1, args, {"content": "x"}))
    access = c.as_dict()
    assert access["read_bash_complete"]
    assert access["read_bash_files"] == ["a.py", "extra.py"]
    score = score_output({"relevant_files": [{"path": "a.py", "weight": 3}]}, {"file_access": access})
    assert score["read_bash"]["recall"] == 1
    assert score["read_bash"]["precision"] == 0.5


def test_split_concurrent_open_is_reassembled_and_deleted_file_is_retained(tmp_path: Path) -> None:
    trace = """22 openat(AT_FDCWD, "deleted.py", O_RDONLY <unfinished ...>
23 openat(AT_FDCWD, ".", O_RDONLY|O_DIRECTORY) = 4</workspace/subdir>
22 <... openat resumed>) = 3</workspace/deleted.py>
"""
    assert opened_files(trace, tmp_path) == ["deleted.py"]
