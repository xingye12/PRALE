import pytest

from agent_harness.domain.tasks import TaskError, transition


def test_projection_does_not_store_reverse_edges_and_updates_fields():
    state, _, _ = transition(None, "task_create", {"subject": "first", "description": ""})
    state, _, _ = transition(state, "task_create", {"subject": "second", "description": ""})
    state, result, _ = transition(
        state,
        "task_update",
        {
            "task_id": "1",
            "add_blocks": ["2", "2"],
            "subject": "new",
            "description": "details",
            "owner": "a",
            "activeForm": "doing",
        },
    )
    assert result["blocks"] == ["2"]
    assert "blocks" not in state["records"]["1"]
    assert state["records"]["2"]["blockedBy"] == ["1"]
    assert result["subject"] == "new" and result["description"] == "details"
    state, _, _ = transition(state, "task_update", {"task_id": "1", "owner": None, "activeForm": None})
    assert state["records"]["1"]["owner"] is None


def test_numeric_pagination_and_filters():
    state = None
    for n in range(12):
        state, _, _ = transition(state, "task_create", {"subject": str(n), "description": ""})
    state, _, _ = transition(state, "task_update", {"task_id": "2", "status": "completed"})
    _, page, changed = transition(state, "task_list", {"offset": 8, "limit": 3})
    assert [t["id"] for t in page["tasks"]] == ["9", "10", "11"]
    assert not changed and page["next_offset"] == 11
    _, page, _ = transition(state, "task_list", {"status": "completed"})
    assert [t["id"] for t in page["tasks"]] == ["2"]
    for args in ({"limit": 101}, {"offset": -1}, {"status": "deleted"}):
        with pytest.raises(TaskError):
            transition(state, "task_list", args)


def test_adding_unfinished_prerequisite_to_active_task_is_atomic():
    state, _, _ = transition(None, "task_create", {"subject": "one", "description": ""})
    state, _, _ = transition(state, "task_create", {"subject": "two", "description": ""})
    for status in ("in_progress", "completed"):
        active, _, _ = transition(state, "task_update", {"task_id": "1", "status": status})
        with pytest.raises(TaskError):
            transition(active, "task_update", {"task_id": "1", "add_blocked_by": ["2"]})
        assert active["records"]["1"]["blockedBy"] == []
