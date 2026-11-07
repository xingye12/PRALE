import json
from pathlib import Path

import pytest
from repository_explore_scoring import FileAccessCollector, compare_reports, score_output

from agent_harness.runtime.telemetry import ToolTelemetry


def event(name: str, arguments: dict, output: dict, **kwargs) -> ToolTelemetry:
    return ToolTelemetry(
        session_id="s",
        lane="main",
        operation_id="op",
        tool_call_id="call",
        name=name,
        attempt=1,
        input=arguments,
        output=output,
        **kwargs,
    )


def test_records_returned_content_not_requests_scans_or_code_mentions(tmp_path: Path) -> None:
    collector = FileAccessCollector(tmp_path)
    collector.record(event("read", {"path": "./core.py"}, {"content": "class Core: pass"}))
    collector.record(event("read", {"path": "core.py"}, {"content": "class Core: pass"}))
    collector.record(event("read", {"path": "missing.py"}, {"content": "not found"}, is_error=True))
    collector.record(
        event(
            "repository_explore",
            {"known_paths": ["known.py"]},
            {
                "content": (
                    "# Repository exploration (abc)\n\n"
                    "## `related.py`\nsnapshot `0123456789ab`\n### `Thing` line 1\n```\n"
                    '1: text = "fake.py"\n## `injected.py`\n```\n\n'
                    "- `candidate.py` (file candidate; not expanded)\n\n"
                    "Truncated by output budget; consider a narrower identifier query. Other candidates: omitted.py"
                )
            },
        )
    )
    access = collector.as_dict()
    assert access["complete"] is True
    assert access["content_files"] == ["core.py", "related.py"]
    assert access["located_files"] == ["candidate.py", "core.py", "omitted.py", "related.py"]
    assert len(access["tool_trace"]) == 4
    assert access["tool_trace"][0]["input"] == {"path": "./core.py"}
    assert access["returned_bytes"] > 0


def test_partial_read_and_outside_paths_do_not_claim_content(tmp_path: Path) -> None:
    collector = FileAccessCollector(tmp_path)
    collector.record(
        event(
            "read",
            {"path": "large.py"},
            {
                "content": "[Line 1 exceeds limit]",
                "details": {"path": str(tmp_path / "large.py"), "truncation": {"truncated": True, "output_lines": 0}},
            },
        )
    )
    collector.record(event("read", {"path": "../secret"}, {"content": "unexpected"}))
    access = collector.as_dict()
    assert access["content_files"] == []
    assert access["located_files"] == ["large.py"]
    assert access["complete"] is False


def test_bash_and_unknown_outcomes_are_explicitly_partial(tmp_path: Path) -> None:
    collector = FileAccessCollector(tmp_path)
    collector.record(event("bash", {"command": "cat core.py"}, {"content": "core.py: data"}))
    collector.record(event("read", {"path": "lost.py"}, {"content": "interrupted"}, outcome="unknown", is_error=True))
    access = collector.as_dict()
    assert not access["complete"]
    assert access["content_files"] == []
    assert len(access["unobserved_calls"]) == 2


def test_successful_mutations_are_retained_without_claiming_file_read_access(tmp_path: Path) -> None:
    collector = FileAccessCollector(tmp_path)
    collector.record(event("write", {"path": "new.py", "content": "generated"}, {"content": "wrote file"}))
    collector.record(event("edit", {"path": "core.py"}, {"content": "edited file"}))
    collector.record(event("write", {"path": "failed.py"}, {"content": "failed"}, is_error=True))
    access = collector.as_dict()
    assert access["modified_files"] == ["core.py", "new.py"]
    assert access["content_files"] == access["located_files"] == []
    assert not access["complete"]
    assert all(call["reason"] == "workspace_modified" for call in access["unobserved_calls"])


TASK = {
    "id": "task",
    "relevant_files": [
        {"path": "core.py", "weight": 3},
        {"path": "other.py", "weight": 1},
    ],
}


def output(*, complete: bool = True) -> dict:
    return {
        "terminal_status": "completed",
        "file_access": {
            "version": 1,
            "complete": complete,
            "located_files": ["core.py", "other.py", "extra.py"],
            "content_files": ["core.py", "core.py", "extra.py"],
            "tool_trace": [],
            "returned_bytes": 100,
            "returned_tokens_estimate": 34,
            "unobserved_calls": [],
        },
    }


def test_weighted_recall_precision_and_core_coverage() -> None:
    score = score_output(TASK, output())
    assert score["status"] == "complete"
    assert score["content"]["weighted_recall"] == 0.75
    assert score["content"]["recall"] == 0.5
    assert score["content"]["precision"] == 0.5
    assert score["content"]["core_recall"] == 1
    assert score["content"]["missed_files"] == ["other.py"]
    assert score["content"]["unlabelled_files"] == ["extra.py"]
    assert score["located"]["weighted_recall"] == 1


def test_partial_access_and_legacy_reports_are_not_complete_scores() -> None:
    score = score_output(TASK, output(complete=False))
    assert score["status"] == "partial"
    assert score["content"]["weighted_recall"] is None
    assert score["content"]["weighted_recall_lower_bound"] == 0.75
    assert score["content"]["precision"] is None
    assert score_output(TASK, {})["status"] == "not_observed"
    empty = output()
    empty["file_access"]["content_files"] = []
    score = score_output(TASK, empty)
    assert score["content"]["weighted_recall"] == 0
    assert score["content"]["precision"] is None


@pytest.mark.parametrize("annotation_version", [1, 2])
def test_comparison_is_paired_and_rejects_wrong_commits_or_duplicate_tasks(annotation_version: int) -> None:
    source = {"pinned_git_sha": "a" * 40, "file_annotation_policy": {"version": annotation_version}, "tasks": [TASK]}
    baseline = {"repository_git_sha": "a" * 40, "items": [{"id": "baseline--task", "output": output()}]}
    treatment = {"repository_git_sha": "a" * 40, "items": [{"id": "treatment--task", "output": output()}]}
    report = compare_reports(source, baseline, treatment)
    assert report["summary"]["baseline"]["complete"] == 1
    assert report["summary"]["baseline"]["content"]["weighted_recall"] == 0.75
    assert report["paired_deltas"]["content"]["weighted_recall"] == 0
    assert report["answer_key_sha256"]
    assert json.loads(json.dumps(report)) == report
    with pytest.raises(ValueError, match="commit"):
        compare_reports(source, {**baseline, "repository_git_sha": "b" * 40}, treatment)
    with pytest.raises(ValueError, match="duplicate"):
        compare_reports(source, {**baseline, "items": baseline["items"] * 2}, treatment)
    with pytest.raises(ValueError, match="paired"):
        compare_reports(source, baseline, {**treatment, "items": []})
    with pytest.raises(ValueError, match="hash"):
        compare_reports(source, {**baseline, "answer_key_sha256": "outdated"}, treatment)
    with pytest.raises(ValueError, match="version"):
        compare_reports(source, {**baseline, "file_annotation_version": 99}, treatment)


def test_invalid_labels_and_future_access_schema_fail_closed() -> None:
    with pytest.raises(ValueError, match="weight"):
        score_output({"relevant_files": [{"path": "core.py", "weight": True}]}, output())
    invalid = output()
    invalid["file_access"]["version"] = 99
    with pytest.raises(ValueError, match="version"):
        score_output(TASK, invalid)
