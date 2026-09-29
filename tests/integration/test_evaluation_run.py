"""A dataset item, run by the real Agent and scored from what it committed.

``run_case`` is the whole point of the evaluation harness: the Agent under test
is the one a deployment serves — the same Session, Drive, tools and settlement
path — and every number a scorer reads is a fact the Drive published *after*
``Session.mutate`` returned.  What is asserted here is what an experiment
therefore rests on: the workspace a run is confined to, the tools a case is
actually offered, and the agreement between the trace an observer sees and the
result that gets scored.
"""

import asyncio
import subprocess
from pathlib import Path

import pytest

from agent_harness.integrations.evaluation import (
    EVALUATORS,
    CaseError,
    EvalCase,
    Expectations,
    RepositorySnapshot,
    RunOutput,
    run_case,
)
from agent_harness.runtime.generation import AssistantResult, GenerationRequest, ToolCall
from agent_harness.runtime.telemetry import GenerationTelemetry, OperationTelemetry, ToolTelemetry
from agent_harness.storage.memory import MemoryStorage
from agent_harness.storage.sqlite import SQLiteStorage

FIXTURE = "the readme says: a durable agent runtime."
ANSWER = "The readme describes a durable agent runtime."
SECRET = "not for the agent to read"

_CASE = EvalCase(
    id="readme-summary",
    prompt="summarise the readme",
    files={"README.md": FIXTURE},
    expectations=Expectations(required_tools=("read",), answer_contract={"contains": ["durable agent runtime"]}),
)


class ScriptedProvider:
    """Reads the fixture once, then answers — the shape of a real turn.

    Keyed by session so a single provider can serve every item of a dataset.
    """

    model = "scripted"

    def __init__(self, *, path: str | None = "README.md", answer: str = ANSWER) -> None:
        self._path = path
        self._answer = answer
        self.requests: list[GenerationRequest] = []
        self._turns: dict[str, int] = {}

    async def generate(self, request: GenerationRequest) -> AssistantResult:
        self.requests.append(request)
        turn = self._turns.get(request.session_id, 0) + 1
        self._turns[request.session_id] = turn
        if turn == 1 and self._path is not None:
            return AssistantResult(
                content="",
                usage={"prompt_tokens": 30, "completion_tokens": 5},
                tool_calls=(ToolCall(f"call-{turn}", "read", {"path": self._path}),),
            )
        return AssistantResult(content=self._answer, usage={"prompt_tokens": 20, "completion_tokens": 7})


class Collector:
    """A sink that keeps every fact the Drive published."""

    def __init__(self) -> None:
        self.events: list = []

    def record(self, event) -> None:
        self.events.append(event)

    def of(self, kind) -> list:
        return [event for event in self.events if isinstance(event, kind)]


def _score(name: str, output: RunOutput, expected: dict) -> float:
    evaluation = EVALUATORS[name](output=output, expected_output=expected)
    assert evaluation is not None, f"{name} declined to score"
    return evaluation.value


def test_a_case_runs_end_to_end_and_reports_what_it_committed(tmp_path: Path) -> None:
    workdir = tmp_path / "run"
    provider = ScriptedProvider()

    output = asyncio.run(run_case(_CASE, provider, workdir=workdir))

    assert output.answer == ANSWER
    assert (output.terminal_status, output.unknown_effects) == ("completed", 0)
    assert output.session_id == "eval:readme-summary"
    assert output.operation_id == "readme-summary-1"
    assert output.generation_count == 2
    # Usage is summed over the turn's committed generations, not taken from the
    # last one: a three-round turn costs what all three rounds cost.
    assert output.usage == {"prompt_tokens": 50, "completion_tokens": 12}
    assert [call.name for call in output.tool_calls] == ["read"]
    assert output.tool_calls[0].is_error is False
    assert output.duration_ms is not None and output.duration_ms >= 0

    # The fixture was written where the tools look for it...
    assert (workdir / "workspace" / "README.md").read_text(encoding="utf-8") == FIXTURE
    # ...and the durable session lives beside the workspace, never inside it,
    # so no relative path from a tool can rewrite the Agent's own history.
    assert (workdir / "session.sqlite").exists()
    assert list((workdir / "workspace").glob("*.sqlite")) == []


def test_the_facts_that_are_uploaded_are_the_facts_that_are_scored(tmp_path: Path) -> None:
    collector = Collector()
    provider = ScriptedProvider()

    output = asyncio.run(run_case(_CASE, provider, workdir=tmp_path / "run", telemetry=collector))

    started, terminal = collector.of(OperationTelemetry)
    [tool] = collector.of(ToolTelemetry)
    # The item's prompt is on the fact that opened the turn and the answer on
    # the one that settled it, which is the pair an evaluator reads.
    assert started.input == {"prompt": _CASE.prompt}
    assert terminal.output["content"] == output.answer
    assert (tool.name, tool.is_error) == ("read", False)
    # One run, one trace, one score: an observer sees exactly the turn the
    # scorers read, because both come from the same published facts.
    assert len(collector.of(GenerationTelemetry)) == output.generation_count
    assert [(call.name, call.is_error, call.outcome) for call in output.tool_calls] == [
        (tool.name, tool.is_error, tool.outcome)
    ]


def test_a_case_is_offered_exactly_the_tools_it_asked_for(tmp_path: Path) -> None:
    provider = ScriptedProvider()

    asyncio.run(run_case(_CASE, provider, workdir=tmp_path / "run"))

    first, second = provider.requests
    assert [tool.name for tool in first.tools] == ["read"]
    assert first.messages[0]["content"] == _CASE.prompt
    # The tool really read the sandbox's own copy: the fixture text reaches the
    # provider only through the run's workspace.
    assert FIXTURE in str(second.messages)


def test_scorers_read_the_committed_turn(tmp_path: Path) -> None:
    output = asyncio.run(run_case(_CASE, ScriptedProvider(), workdir=tmp_path / "run"))
    expected = {
        "terminal_status": "completed",
        "required_tools": ["read"],
        "forbidden_tools": [],
        "expected_tool_errors": [],
        "answer_contract": {"contains": ["durable agent runtime"]},
    }

    assert _score("terminal_success", output, expected) == 1.0
    assert _score("required_tools", output, expected) == 1.0
    assert _score("answer_contract", output, expected) == 1.0
    # The case never forbids anything, so that scorer has no opinion at all.
    assert EVALUATORS["forbidden_tools"](output=output, expected_output=expected) is None


def test_a_read_that_leaves_the_workspace_is_refused_and_the_turn_still_ends(tmp_path: Path) -> None:
    workdir = tmp_path / "run"
    workdir.mkdir()
    (workdir / "outside.txt").write_text(SECRET, encoding="utf-8")
    provider = ScriptedProvider(path="../outside.txt")
    case = EvalCase(id="escapes", prompt="read the notes")

    output = asyncio.run(run_case(case, provider, workdir=workdir))

    # The refusal is a fact like any other: the tool failed, the Agent went on,
    # and nothing left the workspace.
    [call] = output.tool_calls
    assert call.is_error is True
    assert (output.terminal_status, output.answer) == ("completed", ANSWER)
    assert SECRET not in "".join(str(request.messages) for request in provider.requests)


def test_a_reading_case_needs_no_permission_but_a_writing_one_does(tmp_path: Path) -> None:
    provider = ScriptedProvider(path=None)
    writing = EvalCase(id="tidy", prompt="tidy the readme", tools=("write",))

    with pytest.raises(CaseError, match="allow_writing"):
        asyncio.run(run_case(writing, provider, workdir=tmp_path / "refused"))
    # Refused before the first model call, so a dataset that wants a tool the
    # operator did not grant costs nothing to discover.
    assert provider.requests == []

    output = asyncio.run(run_case(writing, provider, workdir=tmp_path / "allowed", allow_writing=True))
    assert [tool.name for tool in provider.requests[0].tools] == ["write"]
    assert output.terminal_status == "completed"


def test_a_caller_can_supply_the_session_and_the_store(tmp_path: Path) -> None:
    async def scenario() -> tuple[RunOutput, list]:
        storage = SQLiteStorage(tmp_path / "mine.sqlite")
        try:
            output = await run_case(
                _CASE, ScriptedProvider(), workdir=tmp_path / "run", storage=storage, session_id="langfuse-1"
            )
            # A store the caller owns outlives the run: only a store this
            # function opened itself is closed here.
            return output, await storage.list_spans(output.operation_id)
        finally:
            storage.close()

    output, spans = asyncio.run(scenario())

    assert output.session_id == "langfuse-1"
    assert [span.kind for span in spans] == ["llm", "tool", "llm"]
    assert not (tmp_path / "run" / "session.sqlite").exists()


def test_a_failed_tool_is_scored_as_the_case_asked(tmp_path: Path) -> None:
    case = EvalCase(
        id="missing-file",
        prompt="read the file that is not there",
        expectations=Expectations(expected_tool_errors=("read",)),
    )

    output = asyncio.run(run_case(case, ScriptedProvider(path="absent.md"), workdir=tmp_path / "run"))

    assert output.tool_calls[0].is_error is True
    assert _score("tool_error_free", output, {"expected_tool_errors": ["read"]}) == 1.0
    assert _score("tool_error_free", output, {"expected_tool_errors": []}) == 0.0


def test_the_same_item_run_twice_is_two_isolated_sessions(tmp_path: Path) -> None:
    async def once(name: str) -> tuple[str, list[str]]:
        output = await run_case(_CASE, ScriptedProvider(), workdir=tmp_path / name, storage=MemoryStorage())
        workspace = tmp_path / name / "workspace"
        return output.session_id, sorted(path.name for path in workspace.iterdir())

    async def scenario() -> tuple[tuple, tuple]:
        return await once("first"), await once("second")

    first, second = asyncio.run(scenario())

    assert first == second == ("eval:readme-summary", ["README.md"])


def _git(root: Path, *arguments: str) -> str:
    completed = subprocess.run(["git", "-C", str(root), *arguments], capture_output=True, text=True, check=True)
    return completed.stdout.strip()


def test_a_case_can_explore_a_detached_read_only_git_snapshot(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    _git(source, "init")
    _git(source, "config", "user.email", "tests@example.invalid")
    _git(source, "config", "user.name", "PRALE tests")
    (source / "README.md").write_text(FIXTURE, encoding="utf-8")
    _git(source, "add", "README.md")
    _git(source, "commit", "-m", "fixture")
    sha = _git(source, "rev-parse", "HEAD")
    case = EvalCase(
        id="snapshot-readme",
        prompt="summarise the readme",
        repository_snapshot=RepositorySnapshot(sha),
        tools=("read",),
    )
    workdir = tmp_path / "run"

    output = asyncio.run(run_case(case, ScriptedProvider(), workdir=workdir, repository_root=source))

    assert output.answer == ANSWER
    # The worktree is detached at the requested commit and removed when the
    # run ends, so one case cannot mutate a later case's checkout.
    assert not (workdir / "workspace").exists()
    assert str(workdir / "workspace") not in _git(source, "worktree", "list", "--porcelain")
    assert (source / "README.md").read_text(encoding="utf-8") == FIXTURE


def test_a_snapshot_case_refuses_to_run_without_its_local_repository(tmp_path: Path) -> None:
    case = EvalCase(
        id="snapshot-needs-root",
        prompt="x",
        repository_snapshot=RepositorySnapshot("a" * 40),
    )

    with pytest.raises(CaseError, match="repository_root is required"):
        asyncio.run(run_case(case, ScriptedProvider(), workdir=tmp_path / "run"))
