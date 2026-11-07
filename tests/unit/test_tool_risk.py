import pytest

from agent_harness.integrations.tool_risk import assess_tool


@pytest.mark.parametrize(
    ("name", "arguments", "expected"),
    [
        ("read", {"path": "src/main.py"}, "allow"),
        ("edit", {"path": "src/main.py"}, "allow"),
        ("read", {"path": ".env.local"}, "allow"),
        ("write", {"path": "AGENTS.md"}, "allow"),
        ("write", {"path": ".env.template"}, "allow"),
        ("write", {"path": "pyproject.toml"}, "allow"),
        ("edit", {"path": "deploy/compose.yml"}, "allow"),
        ("write", {"path": "/tmp/prale-direct-file"}, "ask"),
        ("write", {"path": ".github/workflows/test.yml"}, "allow"),
        ("read", {"path": "../secret"}, "allow"),
        ("bash", {"command": "pwd"}, "allow"),
        ("bash", {"command": "pwd; rm -rf ."}, "ask"),
        ("custom", {}, "ask"),
        ("read", {}, "deny"),
    ],
)
def test_classification(tmp_path, name, arguments, expected):
    assert assess_tool(name, arguments, str(tmp_path)).decision == expected


def test_symlink_escape(tmp_path):
    (tmp_path / "link").symlink_to(tmp_path.parent, target_is_directory=True)
    assert assess_tool("read", {"path": "link/secret"}, str(tmp_path)).decision == "allow"
    assert assess_tool("write", {"path": "link/secret"}, str(tmp_path)).decision == "ask"


def test_deployment_additions_and_sensitive_alias(tmp_path):
    from agent_harness.integrations.local_tools import ReadTool
    from agent_harness.integrations.tool_risk import ConfiguredRiskEvaluator

    (tmp_path / "ordinary.txt").write_text("secret")
    (tmp_path / ".env").symlink_to("ordinary.txt")
    assert assess_tool("read", {"path": ".env"}, str(tmp_path)).decision == "allow"
    policy = ConfiguredRiskEvaluator(sensitive_paths=("private/*.json",))
    assert policy("read", {"path": "private/config.json"}, ReadTool(tmp_path)).decision == "ask"
    assert assess_tool("read", {"path": "id_ed25519"}, str(tmp_path)).decision == "allow"
    assert assess_tool("edit", {"path": "package.json"}, str(tmp_path)).decision == "allow"


def test_schema_validation_does_not_fetch_remote_references(monkeypatch):
    from agent_harness.runtime.tools import invalid_tool_arguments

    class Tool:
        input_schema = {"$ref": "https://unavailable.example/schema.json"}

    def unexpected_network(*args, **kwargs):
        raise AssertionError("schema validation attempted a network request")

    monkeypatch.setattr("urllib.request.urlopen", unexpected_network)
    assert invalid_tool_arguments(Tool(), {}) is not None


def test_external_write_requires_approval(tmp_path):
    assert assess_tool("write", {"path": "../secret"}, str(tmp_path)).decision == "ask"
