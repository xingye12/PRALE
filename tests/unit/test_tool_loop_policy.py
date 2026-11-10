from agent_harness.domain.tool_loop import action_key, blocked_result, observe


def test_canonical_arguments_and_streak_resets():
    assert action_key("tool", {"a": 1, "b": 2}) == action_key("tool", {"b": 2, "a": 1})
    state = {}
    for _ in range(2):
        state, _ = observe(state, "tool", {}, {"content": "err", "is_error": True}, "failed")
    for name, args, result, outcome in [
        ("other", {}, {"content": "err", "is_error": True}, "failed"),
        ("tool", {"changed": True}, {"content": "err", "is_error": True}, "failed"),
        ("tool", {}, {"content": "different", "is_error": True}, "failed"),
        ("tool", {}, {"content": "ok"}, "completed"),
        ("tool", {}, {"content": "err", "is_error": True}, "unknown"),
    ]:
        updated, result = observe(state, name, args, result, outcome)
        assert updated["count"] < 3
        assert not updated.get("blocked")


def test_quarantine_survives_success_and_second_intervention_terminates():
    state = {}
    for _ in range(3):
        state, result = observe(state, "tool", {}, {"content": "err", "is_error": True}, "failed")
    assert "loop_recovery" in result["content"]
    assert not result["terminate"]
    key = action_key("tool", {})
    assert not blocked_result(state, key)["terminate"]
    state["recovery_pending"] = False
    state, _ = observe(state, "other", {}, {"content": "ok"}, "completed")
    assert blocked_result(state, key)["terminate"]
    for _ in range(3):
        state, result = observe(state, "other", {}, {"content": "err", "is_error": True}, "failed")
    assert result["terminate"]
    assert result["error_code"] == "tool_loop_detected"
