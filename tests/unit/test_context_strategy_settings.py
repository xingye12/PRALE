import pytest

from agent_harness.api.errors import ProjectConfigError
from agent_harness.api.settings import Settings


def test_defaults_and_explicit_legacy_configuration(tmp_path):
    env = {"PRALE_API_KEY": "test", "PRALE_REPOSITORY_ID": "repo", "PRALE_PROJECT_ROOT": str(tmp_path)}
    current = Settings.from_environment(env)
    assert current.context_management.strategy == "tool_prune_summary_v1"
    assert current.context_management.context_window_tokens == 512_000
    assert "tool_prune_summary_v1" in current.describe()
    legacy = Settings.from_environment(
        {**env, "PRALE_CONTEXT_STRATEGY": "layered_v1", "PRALE_CONTEXT_MICROCOMPACT_KEEP_RECENT": "3"}
    )
    assert legacy.context_management.context_window_tokens == 128_000
    assert legacy.context_management.microcompact_keep_recent == 3
    with pytest.raises(ProjectConfigError, match="layered_v1"):
        Settings.from_environment({**env, "PRALE_CONTEXT_COLLAPSE": "off"})
    override = Settings.from_environment({**env, "PRALE_CONTEXT_WINDOW_TOKENS": "600000"})
    assert override.context_management.context_window_tokens == 600000
