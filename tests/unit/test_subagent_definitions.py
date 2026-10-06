import pytest

from agent_harness.domain.subagents import InvalidSubagentDefinition, SubagentDefinition
from agent_harness.integrations.subagent_definitions import load_subagent_definitions


def test_definition_loading_is_explicit_and_safe(tmp_path):
    pytest.importorskip("yaml")
    (tmp_path / "review.md").write_text(
        "---\nname: review\ndescription: Review code\ntools: [read]\nmodel: inherit\n---\nReview the task."
    )
    (definition,) = load_subagent_definitions((tmp_path,))
    assert definition.name == "review"
    assert definition.tools == ("read",)
    assert definition.model is None
    assert SubagentDefinition.from_json(definition.to_json()) == definition


@pytest.mark.parametrize(
    "header",
    [
        "name: a\nname: b\ndescription: text",
        "name: a\ndescription: text\ncwd: /tmp",
        "name: a\ndescription: text\nmax_turns: true",
        "name: a\ndescription: text\nbackground: yes-please",
        "name: a\ndescription: text\ntools: read",
        "name: a\ndescription: text\ntools: ['*', read]",
    ],
)
def test_loader_rejects_unsafe_or_ambiguous_definition(tmp_path, header):
    pytest.importorskip("yaml")
    (tmp_path / "bad.md").write_text(f"---\n{header}\n---\nTask")
    with pytest.raises(InvalidSubagentDefinition):
        load_subagent_definitions((tmp_path,))


def test_python_definition_normalizes_inherited_model():
    definition = SubagentDefinition("review", "Review", "Review the task", model="inherit")
    assert definition.model is None
    assert SubagentDefinition.from_json(definition.to_json()) == definition
