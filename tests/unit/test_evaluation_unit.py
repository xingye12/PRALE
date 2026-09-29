"""What an evaluation scores, asserted without running an Agent.

Every scorer reads a run's committed facts and answers with a value or with
``None`` for "this item has no such rule".  The tests are written against the
JSON shape an experiment stores (``RunOutput.as_dict()``) rather than against
the dataclass, because that shape is the contract a Langfuse evaluator and the
CLI's report both read back.
"""

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

from agent_harness.integrations.evaluation import (
    EVALUATORS,
    WRITING_TOOLS,
    CaseError,
    ConfinedTool,
    EvalCase,
    Evaluation,
    Expectations,
    RunOutput,
    ToolCallFact,
    evaluators_for,
    parse_case,
    parse_case_tools,
    run_metrics,
    sandbox_tools,
)
from agent_harness.runtime.tools import ToolExecutionResult


def _output(**overrides) -> dict:
    """A run result in the shape an experiment stores."""

    output = {
        "answer": "the readme describes a durable runtime",
        "tool_calls": [],
        "terminal_status": "completed",
        "generation_count": 2,
        "usage": {"prompt_tokens": 40, "completion_tokens": 8},
        "unknown_effects": 0,
        "duration_ms": 120,
        "error_code": None,
    }
    output.update(overrides)
    return output


def _call(name: str, *, is_error: bool = False, outcome: str = "completed") -> dict:
    return {"name": name, "is_error": is_error, "outcome": outcome}


def _score(scorer, output, expected=None) -> Evaluation | None:
    return scorer(output=output, expected_output=expected)


class _Tool:
    """The smallest thing ``ConfinedTool`` can wrap."""

    name = "fake"
    description = "A tool that declares a path."
    input_schema = {"type": "object", "properties": {"path": {"type": "string"}}}
    replay_policy = "safe"

    def __init__(self) -> None:
        self.seen: list = []

    async def execute(self, arguments):
        self.seen.append(arguments)
        return ToolExecutionResult(content={"ok": True})


# -- parsing a dataset item -------------------------------------------------- #


def test_a_minimal_item_takes_the_read_only_defaults() -> None:
    case = parse_case({"input": {"prompt": "summarise the readme"}}, fallback_id="item-1")

    assert case.id == "item-1"
    assert case.prompt == "summarise the readme"
    # A case that says nothing is a case that reads nothing and forbids nothing:
    # an empty rule is not a rule, and a default that guessed harder would make
    # an item's own expectations unreadable from the item.
    assert case.tools == ("read",)
    assert case.files == {}
    assert case.risk == "normal"
    assert case.expectations == Expectations()


@pytest.mark.parametrize(
    "item",
    [
        {},  # no input at all
        {"input": "summarise the readme"},  # input is prose, not a request
        {"input": {}},  # no prompt
        {"input": {"prompt": ""}},  # an empty prompt is not a prompt
        {"input": {"prompt": 3}},
    ],
)
def test_an_item_that_does_not_say_what_to_run_is_refused(item) -> None:
    with pytest.raises(CaseError):
        parse_case(item)


def test_a_fixture_that_could_leave_the_workspace_is_refused() -> None:
    for name in ("../escape.md", "/etc/passwd", "notes/../../escape.md"):
        with pytest.raises(CaseError):
            parse_case({"input": {"prompt": "read it", "files": {name: "text"}}})

    case = parse_case({"input": {"prompt": "read it", "files": {"notes/readme.md": "text"}}})
    assert case.files == {"notes/readme.md": "text"}


def test_an_item_is_read_whole_into_its_case() -> None:
    case = parse_case(
        {
            "input": {
                "prompt": "read the readme",
                "files": {"README.md": "the readme"},
                "tools": ["read", "repository_explore"],
            },
            "expected_output": {
                "terminal_status": "completed",
                "required_tools": ["read"],
                "forbidden_tools": ["bash"],
                "expected_tool_errors": ["read"],
                "answer_contract": {"contains": ["durable"]},
            },
            "metadata": {"id": "readme-summary", "risk": "normal"},
        }
    )

    assert (case.id, case.tools) == ("readme-summary", ("read", "repository_explore"))
    assert case.files == {"README.md": "the readme"}
    assert case.expectations.required_tools == ("read",)
    assert case.expectations.forbidden_tools == ("bash",)
    assert case.expectations.expected_tool_errors == ("read",)
    assert case.expectations.answer_contract == {"contains": ["durable"]}


@pytest.mark.parametrize(
    "item",
    [
        {"input": {"prompt": "x", "tools": "read"}},  # a string is not a list of tools
        {"input": {"prompt": "x", "tools": ["read", ""]}},
        {"input": {"prompt": "x", "files": ["README.md"]}},
        {"input": {"prompt": "x", "files": {"README.md": 3}}},
        {"input": {"prompt": "x"}, "metadata": {"id": 3}},
        {"input": {"prompt": "x"}, "expected_output": {"answer_contract": ["durable"]}},
        {"input": {"prompt": "x"}, "metadata": "case-1"},
    ],
)
def test_a_malformed_item_is_refused_rather_than_guessed_at(item) -> None:
    with pytest.raises(CaseError):
        parse_case(item)


def test_a_dataset_id_is_only_taken_when_the_item_has_one() -> None:
    assert parse_case({"input": {"prompt": "x"}, "metadata": {"id": "case-1"}}).id == "case-1"
    # An item that never named itself is named by its position instead, so a
    # dataset is a list of distinct cases even when its author left the ids out.
    assert parse_case({"input": {"prompt": "x"}}, fallback_id="item-7").id == "item-7"
    assert parse_case({"input": {"prompt": "x"}, "metadata": {"id": ""}}, fallback_id="item-7").id == "item-7"


# -- which tools a case may have --------------------------------------------- #


def test_the_run_decides_what_a_case_may_use_not_the_case() -> None:
    # An item can write any expectations it likes; the tools are still decided
    # by the deployment running the experiment.
    case = parse_case({"input": {"prompt": "tidy the repo", "tools": ["read", "bash"]}})

    with pytest.raises(CaseError, match="allow_writing"):
        parse_case_tools(case)
    assert parse_case_tools(case, allow_writing=True) == ("read", "bash")


def test_read_only_tools_need_no_flag_and_are_deduplicated() -> None:
    case = EvalCase(id="case-1", prompt="x", tools=("read", "repository_explore", "read"))

    assert parse_case_tools(case) == ("read", "repository_explore")


def test_a_tool_the_runtime_does_not_have_is_refused() -> None:
    # Silently dropping it would turn a dataset bug into a scored failure that
    # blames the Agent for a tool it was never given.
    case = EvalCase(id="case-1", prompt="x", tools=("read", "write_file"))

    with pytest.raises(CaseError, match="write_file"):
        parse_case_tools(case)
    with pytest.raises(CaseError, match="write_file"):
        parse_case_tools(case, allow_writing=True)


def test_every_writing_tool_is_behind_the_same_flag() -> None:
    case = EvalCase(id="case-1", prompt="x", tools=tuple(sorted(WRITING_TOOLS)))

    with pytest.raises(CaseError):
        parse_case_tools(case)


# -- the sandbox -------------------------------------------------------------- #


def test_a_path_that_leaves_the_workspace_is_refused(tmp_path: Path) -> None:
    inner = _Tool()
    tool = ConfinedTool(inner, tmp_path / "workspace")
    (tmp_path / "workspace").mkdir()
    (tmp_path / "outside.txt").write_text("not for the agent")

    for attempt in ("../outside.txt", str(tmp_path / "outside.txt"), "/etc/passwd"):
        result = asyncio.run(tool.execute({"path": attempt}))
        assert result.is_error is True
        assert "refused" in str(result.content)
    # Refused before the tool saw it: nothing was read and nothing was escaped.
    assert inner.seen == []


def test_a_path_inside_the_workspace_is_passed_through(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    inner = _Tool()
    tool = ConfinedTool(inner, root)

    for allowed in ("README.md", "./notes/readme.md", str(root / "README.md"), "."):
        asyncio.run(tool.execute({"path": allowed}))
    # Anything that is not a path at all is the tool's business, not the gate's.
    asyncio.run(tool.execute({"path": 3}))
    asyncio.run(tool.execute({}))

    assert [argument.get("path") for argument in inner.seen] == [
        "README.md",
        "./notes/readme.md",
        str(root / "README.md"),
        ".",
        3,
        None,
    ]


def test_the_wrapper_presents_the_tool_it_wraps(tmp_path: Path) -> None:
    inner = _Tool()
    tool = ConfinedTool(inner, tmp_path)

    assert (tool.name, tool.description) == (inner.name, inner.description)
    assert tool.input_schema == inner.input_schema
    assert tool.replay_policy == inner.replay_policy


def test_a_confined_read_really_cannot_leave_the_workspace(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "README.md").write_text("the readme")
    (tmp_path / "secret.txt").write_text("a secret")
    [read] = sandbox_tools(root, ["read"])

    inside = asyncio.run(read.execute({"path": "README.md"}))
    outside = asyncio.run(read.execute({"path": "../secret.txt"}))

    assert "the readme" in str(inside.content)
    assert outside.is_error is True
    assert "a secret" not in str(outside.content)


def test_a_tool_without_a_path_argument_is_left_alone(tmp_path: Path) -> None:
    # ``bash`` takes a command, not a path: no wrapper can promise what it
    # does, which is exactly why it is behind the writing flag instead.
    [bash] = sandbox_tools(tmp_path, ["bash"])

    assert bash.name == "bash"
    assert not isinstance(bash, ConfinedTool)
    assert [tool.name for tool in sandbox_tools(tmp_path, ["read", "bash"])] == ["read", "bash"]


def test_a_tool_the_runtime_does_not_have_is_refused_by_the_sandbox(tmp_path: Path) -> None:
    with pytest.raises(CaseError, match="nope"):
        sandbox_tools(tmp_path, ["read", "nope"])


# -- scorers ------------------------------------------------------------------ #


def test_terminal_success_needs_a_terminal_state_without_unproven_effects() -> None:
    assert _score(EVALUATORS["terminal_success"], _output()).value == 1.0
    # An effect the process could not prove is not a success, whatever the
    # operation's status says.
    unknown = _score(EVALUATORS["terminal_success"], _output(unknown_effects=1))
    assert (unknown.value, unknown.comment) == (0.0, "1 effect(s) could not be proven")

    failed = _score(EVALUATORS["terminal_success"], _output(terminal_status="failed"))
    assert failed.value == 0.0
    assert "failed" in (failed.comment or "")
    assert _score(EVALUATORS["terminal_success"], _output(terminal_status="failed"), {"terminal_status": "failed"})


def test_required_tools_scores_nothing_when_the_item_requires_nothing() -> None:
    assert _score(EVALUATORS["required_tools"], _output(tool_calls=[_call("read")])) is None

    missing = _score(EVALUATORS["required_tools"], _output(), {"required_tools": ["read"]})
    assert (missing.value, missing.comment) == (0.0, "never called: read")
    # A call counts as used however it ended: whether it *worked* is what
    # tool_error_free is for.
    assert (
        _score(
            EVALUATORS["required_tools"],
            _output(tool_calls=[_call("read", is_error=True)]),
            {"required_tools": ["read"]},
        ).value
        == 1.0
    )


def test_forbidden_tools_scores_nothing_when_the_item_forbids_nothing() -> None:
    assert _score(EVALUATORS["forbidden_tools"], _output(tool_calls=[_call("bash")])) is None

    violation = _score(
        EVALUATORS["forbidden_tools"], _output(tool_calls=[_call("read"), _call("bash")]), {"forbidden_tools": ["bash"]}
    )
    assert (violation.value, violation.comment) == (0.0, "called: bash")
    assert (
        _score(EVALUATORS["forbidden_tools"], _output(tool_calls=[_call("read")]), {"forbidden_tools": ["bash"]}).value
        == 1.0
    )


def test_tool_error_free_scores_a_failure_the_item_expects_as_a_pass() -> None:
    assert _score(EVALUATORS["tool_error_free"], _output()).value == 1.0

    failed = _score(EVALUATORS["tool_error_free"], _output(tool_calls=[_call("read", is_error=True)]))
    assert (failed.value, failed.comment) == (0.0, "failed: read")
    # A case that asks for a file that is not there is testing the recovery,
    # not the failure.
    assert (
        _score(
            EVALUATORS["tool_error_free"],
            _output(tool_calls=[_call("read", is_error=True)]),
            {"expected_tool_errors": ["read"]},
        ).value
        == 1.0
    )


def test_answer_contract_scores_nothing_when_the_item_contracts_nothing() -> None:
    assert _score(EVALUATORS["answer_contract"], _output()) is None
    assert _score(EVALUATORS["answer_contract"], _output(), {"answer_contract": {}}) is None


@pytest.mark.parametrize(
    ("contract", "answer", "value"),
    [
        ({"exact": "done"}, "done", 1.0),
        ({"exact": "done"}, "done.", 0.0),
        ({"contains": ["durable", "runtime"]}, "a durable runtime", 1.0),
        ({"contains": ["durable", "sandbox"]}, "a durable runtime", 0.0),
        ({"json": True}, '{"answer": "done"}', 1.0),
        ({"json": True}, "the answer is done", 0.0),
        ({"json": True}, '```json\n{"answer": "done"}\n```', 1.0),  # the fenced block a model writes
        ({"json": True, "schema": {"required": ["answer"]}}, '{"other": 1}', 0.0),
        ({"json": True, "schema": {"required": ["answer"]}}, '{"answer": "done"}', 1.0),
    ],
)
def test_an_answer_contract_reads_the_answer_it_was_given(contract, answer, value) -> None:
    score = _score(EVALUATORS["answer_contract"], _output(answer=answer), {"answer_contract": contract})

    assert score.value == value


def test_the_budget_metrics_measure_the_run_against_the_item() -> None:
    output = _output(
        tool_calls=[_call("read"), _call("read", is_error=True)],
        usage={"prompt_tokens": 40, "completion_tokens": 8},
        duration_ms=120,
    )

    assert _score(EVALUATORS["tool_count"], output).value == 2.0
    assert _score(EVALUATORS["tool_count"], output, {"tool_budget": 1}).comment == "2 call(s), budget 1 (over budget)"
    assert _score(EVALUATORS["tool_count"], output, {"tool_budget": 5}).comment == "2 call(s), budget 5"
    assert _score(EVALUATORS["latency"], output).value == 120.0
    assert _score(EVALUATORS["latency"], output, {"latency_budget_ms": 120}).comment == "120 ms, budget 120"
    assert _score(EVALUATORS["token_cost"], output).value == 48.0
    assert (
        _score(EVALUATORS["token_cost"], output, {"token_budget": 10}).comment == "48 token(s), budget 10 (over budget)"
    )


def test_a_metric_a_run_did_not_measure_is_not_scored() -> None:
    # ``None`` is "no opinion", so an item stays comparable with a run that
    # could not record the number rather than being scored as a zero.
    assert _score(EVALUATORS["latency"], _output(duration_ms=None)) is None
    assert _score(EVALUATORS["token_cost"], _output(usage={})) is None


def test_a_scorer_reads_a_run_output_as_readily_as_its_json() -> None:
    run = RunOutput(
        answer="done",
        tool_calls=(ToolCallFact("read", False, "completed"),),
        terminal_status="completed",
        generation_count=1,
        usage={"prompt_tokens": 1},
        duration_ms=5,
    )

    assert _score(EVALUATORS["terminal_success"], run).value == 1.0
    assert _score(EVALUATORS["required_tools"], run, {"required_tools": ["read"]}).value == 1.0
    assert _score(EVALUATORS["tool_count"], run).value == 1.0


def test_something_that_is_not_a_run_result_is_refused() -> None:
    with pytest.raises(CaseError):
        _score(EVALUATORS["terminal_success"], "completed")


def test_an_unknown_scorer_is_refused_before_anything_runs() -> None:
    names = ["terminal_success", "tool_error_free"]

    assert [scorer.__name__ for scorer in evaluators_for(names)] == names
    with pytest.raises(CaseError, match="latency_p99"):
        evaluators_for(["latency_p99"])


# -- run metrics -------------------------------------------------------------- #


def _item(**evaluations: float) -> SimpleNamespace:
    return SimpleNamespace(evaluations=[Evaluation(name, value) for name, value in evaluations.items()])


def test_a_run_with_nothing_scored_has_no_metrics() -> None:
    assert run_metrics([]) == []
    assert run_metrics([_item()]) == []


def test_the_metrics_are_rates_over_the_items_that_were_scored() -> None:
    items = [
        _item(terminal_success=1.0, tool_count=2.0, latency=100.0, token_cost=40.0),
        _item(terminal_success=0.0, tool_count=4.0, latency=300.0, token_cost=60.0),
        _item(terminal_success=1.0, tool_count=3.0, latency=200.0, token_cost=50.0),
    ]

    metrics = {metric.name: metric.value for metric in run_metrics(items)}

    assert metrics["terminal_success_rate"] == pytest.approx(2 / 3)
    # An item with no such rule contributes to no average: a rate is over the
    # items that were scored, not over the dataset.
    assert metrics["tool_count_mean"] == pytest.approx(3.0)
    assert metrics["latency_p95"] == pytest.approx(300.0)
    assert metrics["token_cost_total"] == pytest.approx(150.0)
    assert "forbidden_tools_rate" not in metrics


def test_a_metric_nothing_scored_is_left_out_of_the_run() -> None:
    metrics = {metric.name: metric.value for metric in run_metrics([_item(terminal_success=1.0, tool_count=1.0)])}

    assert set(metrics) == {"terminal_success_rate", "tool_count_mean"}
    [mean] = [metric for metric in run_metrics([_item(tool_count=1.0)]) if metric.name == "tool_count_mean"]
    assert mean.comment == "max 1"
