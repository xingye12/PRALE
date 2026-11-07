import asyncio
import json
import subprocess
import sys
from pathlib import Path

import pytest
from repository_explore_scoring import FileAccessCollector, compare_reports, score_output
from run_repository_explore import _parser, run

from agent_harness.integrations.evaluation import EvalCase, run_case
from agent_harness.integrations.repository_explorer import (
    IndexedFile,
    RepositoryExplorerConfig,
    RepositoryExplorerTool,
    RepositoryTag,
)
from agent_harness.runtime.generation import AssistantResult, GenerationRequest, ToolCall


class Provider:
    model = "scripted"

    def __init__(self) -> None:
        self.turns: dict[str, int] = {}
        self.requests: list[GenerationRequest] = []

    async def generate(self, request: GenerationRequest) -> AssistantResult:
        self.requests.append(request)
        turn = self.turns.get(request.session_id, 0)
        self.turns[request.session_id] = turn + 1
        if turn == 0:
            return AssistantResult(
                "", {"total_tokens": 10}, tool_calls=(ToolCall("read-1", "read", {"path": "core.py"}),)
            )
        return AssistantResult('{"summary":"done"}', {"total_tokens": 5})


def test_committed_read_content_is_kept_after_temporary_session_is_removed(tmp_path: Path) -> None:
    collector = FileAccessCollector(tmp_path / "workspace")
    case = EvalCase(id="t", prompt="read core", files={"core.py": "def core(): pass\n"})
    result = asyncio.run(run_case(case, Provider(), workdir=tmp_path, telemetry=collector))
    access = collector.as_dict()
    assert access["content_files"] == ["core.py"]
    assert access["complete"]
    assert access["tool_trace"][0]["output"]["content"] == "def core(): pass\n"
    assert result.terminal_status == "completed"


def test_real_explorer_render_is_observed_but_internal_index_files_are_not(tmp_path: Path) -> None:
    class Indexer:
        async def index(self, include_tests: bool) -> tuple[IndexedFile, ...]:
            return (
                IndexedFile("core.py", "hash", (RepositoryTag("core.py", "core", "definition", "function", 1),), True),
                IndexedFile("scan-only.txt", "hash", (), False),
            )

    class ExplorerProvider(Provider):
        async def generate(self, request: GenerationRequest) -> AssistantResult:
            result = await super().generate(request)
            if result.tool_calls:
                return AssistantResult(
                    "", {}, tool_calls=(ToolCall("explore-1", "repository_explore", {"identifiers": ["core"]}),)
                )
            return result

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    tool = RepositoryExplorerTool(RepositoryExplorerConfig(workspace, tmp_path / "index"), Indexer())
    collector = FileAccessCollector(workspace)
    case = EvalCase(
        id="explorer",
        prompt="Find core",
        files={"core.py": "def core(): pass\n", "scan-only.txt": "noise"},
        tools=("repository_explore",),
    )
    result = asyncio.run(
        run_case(case, ExplorerProvider(), workdir=tmp_path, telemetry=collector, repository_explorer=tool)
    )
    access = collector.as_dict()
    assert result.terminal_status == "completed"
    assert access["complete"]
    assert access["located_files"] == access["content_files"] == ["core.py"]


@pytest.mark.parametrize("read_only", [True, False])
def test_paired_runner_and_offline_cli_use_the_same_facts_without_leaking_labels(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    read_only: bool,
) -> None:
    repository = tmp_path / "repo"
    repository.mkdir()
    for arguments in (["init", "-q"], ["config", "user.name", "Eval"], ["config", "user.email", "eval@example.test"]):
        subprocess.run(["git", "-C", str(repository), *arguments], check=True)
    (repository / "core.py").write_text("def core(): pass\n")
    subprocess.run(["git", "-C", str(repository), "add", "core.py"], check=True)
    subprocess.run(["git", "-C", str(repository), "commit", "-qm", "fixture"], check=True)
    sha = subprocess.check_output(["git", "-C", str(repository), "rev-parse", "HEAD"], text=True).strip()
    task = {
        "id": "one",
        "prompt": "Read core.py",
        "category": "test",
        "relevant_files": [{"path": "core.py", "weight": 3, "reason": "PRIVATE-LABEL-REASON"}],
    }
    source = {
        "pinned_git_sha": sha,
        "file_annotation_policy": {"version": 1, "verified_git_sha": sha},
        "tasks": [task],
        "global_output_contract": {"required_fields": ["summary"]},
    }
    tasks = tmp_path / "tasks.json"
    tasks.write_text(json.dumps(source))
    out = tmp_path / "reports"
    arguments = ["--tasks", str(tasks), "--repository-root", str(repository), "--output-dir", str(out)]
    if read_only:
        arguments.append("--read-only")
    else:
        # Test the primary runner's full tool policy without requiring Docker;
        # container routing and actual mutations are covered separately below.
        async def local_export(case, provider, workdir, image):
            collector = FileAccessCollector(workdir / "workspace")
            result = await run_case(case, provider, workdir=workdir, telemetry=collector, allow_writing=True)
            return {**result.as_dict(), "file_access": collector.as_dict()}

        monkeypatch.setattr("run_repository_explore_bash.run_export", local_export)
    args = _parser().parse_args(arguments)
    provider = Provider()
    comparison = asyncio.run(run(args, provider=provider))
    assert comparison["summary"]["baseline"]["content"]["weighted_recall"] == 1
    assert comparison["summary"]["treatment"]["content"]["precision"] == 1
    assert comparison["summary"]["baseline"]["costs"]["provider_total_tokens"]["total"] == 15
    assert comparison["paired_deltas"]["content"]["weighted_recall_pairs"] == 1
    assert all("PRIVATE-LABEL-REASON" not in json.dumps(r.messages) for r in provider.requests)
    base = ["read"] if read_only else ["read", "bash", "edit", "write"]
    assert [t.name for t in provider.requests[0].tools] == base
    assert any([t.name for t in r.tools] == [*base, "repository_explore"] for r in provider.requests)
    reports = [json.loads((out / f"{condition}.json").read_text()) for condition in ("baseline", "treatment")]
    assert compare_reports(source, *reports) == comparison
    subprocess.run(
        [
            sys.executable,
            "scripts/score_repository_explore.py",
            "--tasks",
            str(tasks),
            "--baseline",
            str(out / "baseline.json"),
            "--treatment",
            str(out / "treatment.json"),
            "--output",
            str(out / "offline.json"),
        ],
        check=True,
        capture_output=True,
    )
    assert json.loads((out / "offline.json").read_text()) == comparison
    assert score_output(task, reports[0]["items"][0]["output"])["content"]["matched_files"] == ["core.py"]


def test_export_executes_write_edit_read_and_routes_bash_into_container(tmp_path: Path, monkeypatch) -> None:
    import run_repository_explore_bash as runner

    from agent_harness.runtime.tools import ToolExecutionResult

    commands = []
    mounts = []
    removed = []
    original_tools = runner.sandbox_tools

    def start_container(command, **kwargs):
        assert command[:3] == ["docker", "run", "-d"]
        assert command[command.index("--network") + 1] == "none"
        mounts.append(command[command.index("--mount") + 1])
        return "fixture-container\n"

    def remove_container(command, **kwargs):
        removed.append(command)

    def tools_with_fake_shell(*args, **kwargs):
        tools = original_tools(*args, **kwargs)
        shell = next(t for t in tools if t.name == "bash")

        class Shell:
            name = shell.name
            description = shell.description
            input_schema = shell.input_schema
            replay_policy = shell.replay_policy

            async def execute(self, arguments):
                commands.append(arguments["command"])
                return ToolExecutionResult(content="container output")

        return tuple(Shell() if tool.name == "bash" else tool for tool in tools)

    class EditingProvider(Provider):
        async def generate(self, request):
            turn = self.turns.get(request.session_id, 0)
            self.turns[request.session_id] = turn + 1
            calls = [
                ("write", {"path": "scratch.py", "content": "first\n"}),
                ("edit", {"path": "scratch.py", "edits": [{"oldText": "first", "newText": "second"}]}),
                ("read", {"path": "scratch.py"}),
                ("bash", {"command": "cat scratch.py"}),
                ("write", {"path": "../escaped.py", "content": "must be refused"}),
            ]
            if turn < len(calls):
                name, arguments = calls[turn]
                return AssistantResult("", {}, tool_calls=(ToolCall(f"call-{turn}", name, arguments),))
            return AssistantResult("done", {})

    monkeypatch.setattr(runner.subprocess, "check_output", start_container)
    monkeypatch.setattr(runner.subprocess, "run", remove_container)
    monkeypatch.setattr(runner, "sandbox_tools", tools_with_fake_shell)
    for condition in ("baseline", "treatment"):
        workdir = tmp_path / condition
        workspace = workdir / "workspace"
        workspace.mkdir(parents=True)
        assert not (workspace / "scratch.py").exists()
        names = ("read", "bash", "edit", "write") + (("repository_explore",) if condition == "treatment" else ())
        case = EvalCase(id=condition, prompt="exercise tools", tools=names)
        output = asyncio.run(runner.run_export(case, EditingProvider(), workdir, "fixture-image"))
        trace = output["file_access"]["tool_trace"]
        assert not any(call["is_error"] for call in trace[:4])
        assert trace[2]["output"]["content"] == "second\n"
        assert trace[4]["is_error"]
        assert not (workdir / "escaped.py").exists()
        assert (workspace / "scratch.py").read_text() == "second\n"
        assert output["file_access"]["modified_files"] == ["scratch.py"]
        assert not output["file_access"]["complete"]
    assert len(commands) == 2
    assert all("strace" in command and "scratch.py" in command for command in commands)
    assert len(set(mounts)) == 2
    assert removed == [["docker", "rm", "-f", "fixture-container"]] * 2
