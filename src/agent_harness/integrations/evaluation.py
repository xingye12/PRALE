"""Run the harness on a fixed dataset, offline, and score what it produced.

An experiment is a *run* of the real Agent — the same Session, Drive, tools and
settlement path a deployment uses — against one dataset item, in a workspace
that is thrown away afterwards.  The scores are computed from the facts the
Drive published after each settlement (``runtime/telemetry.py``), never from
the model's own prose, so a scorer reads exactly what was committed.

Two things are deliberately *not* here.  There is no Langfuse import: the
scorers and the sandbox are plain functions over plain values, which is what
makes them testable and what lets a deployment run an experiment without the
optional extra.  And there is no OS sandbox — see :func:`run_case` for what a
run does and does not isolate.
"""

import json
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Final

from agent_harness.api.harness import Harness
from agent_harness.api.models import OperationResult
from agent_harness.domain.entries import JsonValue
from agent_harness.integrations.local_tools import create_builtin_tools
from agent_harness.runtime.generation import ChatProvider
from agent_harness.runtime.telemetry import (
    GenerationTelemetry,
    OperationTelemetry,
    TelemetryEvent,
    TelemetrySink,
    ToolTelemetry,
    publish,
)
from agent_harness.runtime.tools import AgentTool, ToolExecutionResult
from agent_harness.storage.protocol import Storage
from agent_harness.storage.sqlite import SQLiteStorage

__all__ = [
    "EVALUATORS",
    "READ_ONLY_TOOLS",
    "WRITING_TOOLS",
    "CaseError",
    "ConfinedTool",
    "EvalCase",
    "Evaluation",
    "Expectations",
    "RunOutput",
    "ToolCallFact",
    "evaluators_for",
    "parse_case",
    "parse_case_tools",
    "run_case",
    "run_metrics",
    "sandbox_tools",
]

READ_ONLY_TOOLS: Final = frozenset({"read", "repository_explore"})
"""Tools that cannot change the workspace, whatever they are asked to do."""

WRITING_TOOLS: Final = frozenset({"write", "edit", "bash"})
"""Tools that can change a workspace or the machine around it."""

_PATH_ARGUMENT: Final = "path"
_MAX_ANSWER_CHARS: Final = 20_000


class CaseError(ValueError):
    """A dataset item that cannot be run as written."""


@dataclass(frozen=True, slots=True)
class ToolCallFact:
    """One tool attempt, as the Drive published it."""

    name: str
    is_error: bool
    outcome: str


@dataclass(frozen=True, slots=True)
class Expectations:
    """What a dataset item says a good run looks like.

    An empty rule is not a rule: an item that forbids nothing forbids nothing.
    Which tools are *available* is a separate decision, made by the run rather
    than by the item, so a case cannot widen its own permissions by writing
    expectations.
    """

    terminal_status: str = "completed"
    required_tools: tuple[str, ...] = ()
    forbidden_tools: tuple[str, ...] = ()
    expected_tool_errors: tuple[str, ...] = ()
    answer_contract: Mapping[str, JsonValue] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class EvalCase:
    """One dataset item, validated into something runnable."""

    id: str
    prompt: str
    files: Mapping[str, str] = field(default_factory=dict)
    tools: tuple[str, ...] = ("read",)
    expectations: Expectations = field(default_factory=Expectations)
    risk: str = "normal"


@dataclass(frozen=True, slots=True)
class RunOutput:
    """What one run produced: the contract every scorer reads."""

    answer: str
    tool_calls: tuple[ToolCallFact, ...]
    terminal_status: str
    generation_count: int
    usage: Mapping[str, int | float]
    unknown_effects: int = 0
    duration_ms: int | None = None
    error_code: str | None = None
    error_message: str | None = None
    session_id: str = ""
    operation_id: str = ""

    def as_dict(self) -> dict[str, JsonValue]:
        """The JSON shape the experiment stores and the scorers parse back."""

        return {
            "answer": self.answer,
            "tool_calls": [
                {"name": call.name, "is_error": call.is_error, "outcome": call.outcome} for call in self.tool_calls
            ],
            "terminal_status": self.terminal_status,
            "generation_count": self.generation_count,
            "usage": dict(self.usage),
            "unknown_effects": self.unknown_effects,
            "duration_ms": self.duration_ms,
            "error_code": self.error_code,
        }


@dataclass(frozen=True, slots=True)
class Evaluation:
    """One score, in the shape a Langfuse evaluator returns."""

    name: str
    value: float
    comment: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {"name": self.name, "value": self.value, "comment": self.comment}


# -- parsing ---------------------------------------------------------------- #


def _require_text(value: object, *, where: str) -> str:
    if not isinstance(value, str) or not value:
        raise CaseError(f"{where} must be a non-empty string")
    return value


def _text_tuple(value: object, *, where: str) -> tuple[str, ...]:
    if value is None:
        return ()
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        raise CaseError(f"{where} must be a list of names")
    return tuple(_require_text(item, where=f"{where} entries") for item in value)


def parse_case(item: Mapping[str, Any], *, fallback_id: str = "item") -> EvalCase:
    """Validate a dataset item, refusing anything ambiguous.

    A dataset is a fixture, so an item whose expectations cannot be read is a
    bug in the dataset: the experiment is refused rather than scored against a
    guess about what the author meant.
    """

    raw_input = item.get("input")
    if not isinstance(raw_input, Mapping):
        raise CaseError(f"{fallback_id}: input must be an object with a prompt")
    prompt = _require_text(raw_input.get("prompt"), where=f"{fallback_id}: input.prompt")

    files: dict[str, str] = {}
    raw_files = raw_input.get("files", {})
    if not isinstance(raw_files, Mapping):
        raise CaseError(f"{fallback_id}: input.files must be an object of path -> text")
    for name, content in raw_files.items():
        if not isinstance(content, str):
            raise CaseError(f"{fallback_id}: input.files[{name!r}] must be text")
        relative = Path(str(name))
        if relative.is_absolute() or ".." in relative.parts:
            raise CaseError(f"{fallback_id}: input.files[{name!r}] must stay inside the workspace")
        files[str(name)] = content

    metadata = item.get("metadata") or {}
    if not isinstance(metadata, Mapping):
        raise CaseError(f"{fallback_id}: metadata must be an object")
    expected = item.get("expected_output") or {}
    if not isinstance(expected, Mapping):
        raise CaseError(f"{fallback_id}: expected_output must be an object")
    contract = expected.get("answer_contract", {})
    if not isinstance(contract, Mapping):
        raise CaseError(f"{fallback_id}: expected_output.answer_contract must be an object")

    identifier = metadata.get("id")
    case_id = _require_text(identifier, where=f"{fallback_id}: metadata.id") if identifier else fallback_id
    risk = metadata.get("risk")
    return EvalCase(
        id=case_id,
        prompt=prompt,
        files=files,
        tools=_text_tuple(raw_input.get("tools"), where=f"{case_id}: input.tools") or ("read",),
        expectations=Expectations(
            terminal_status=str(expected.get("terminal_status", "completed")),
            required_tools=_text_tuple(expected.get("required_tools"), where=f"{case_id}: required_tools"),
            forbidden_tools=_text_tuple(expected.get("forbidden_tools"), where=f"{case_id}: forbidden_tools"),
            expected_tool_errors=_text_tuple(expected.get("expected_tool_errors"), where=f"{case_id}: errors"),
            answer_contract=dict(contract),
        ),
        risk=risk if isinstance(risk, str) and risk else "normal",
    )


def parse_case_tools(case: EvalCase, *, allow_writing: bool = False) -> tuple[str, ...]:
    """The tools this case may actually use, given the operator's policy.

    A dataset says what a case *wants*; whether it may have it is decided here,
    by the deployment running the experiment.  A case that asks for a tool the
    runtime does not have is refused either way, because a silently missing
    tool turns into a scored failure that blames the agent.
    """

    wanted = tuple(dict.fromkeys(case.tools))
    unknown = [name for name in wanted if name not in READ_ONLY_TOOLS | WRITING_TOOLS]
    if unknown:
        raise CaseError(f"{case.id}: unknown tools {', '.join(sorted(unknown))}")
    if allow_writing:
        return wanted
    writing = [name for name in wanted if name in WRITING_TOOLS]
    if writing:
        raise CaseError(
            f"{case.id}: {', '.join(writing)} can change the machine and this run is read-only; "
            "run it with allow_writing=True to accept that"
        )
    return wanted


# -- the sandbox ------------------------------------------------------------ #


@dataclass(frozen=True, slots=True)
class ConfinedTool:
    """A tool whose ``path`` argument cannot leave the sandbox root."""

    tool: AgentTool
    root: Path

    @property
    def name(self) -> str:
        return self.tool.name

    @property
    def description(self) -> str:
        return self.tool.description

    @property
    def input_schema(self) -> JsonValue:
        return self.tool.input_schema

    @property
    def replay_policy(self) -> str:
        return self.tool.replay_policy

    async def execute(self, arguments: JsonValue) -> ToolExecutionResult:
        value = arguments.get(_PATH_ARGUMENT) if isinstance(arguments, Mapping) else None
        if isinstance(value, str) and value:
            candidate = Path(value)
            if not candidate.is_absolute():
                candidate = self.root / candidate
            if not candidate.resolve().is_relative_to(self.root.resolve()):
                return ToolExecutionResult(
                    content=f"{self.name} refused {value!r}: an evaluation run reads only inside its own workspace",
                    is_error=True,
                )
        return await self.tool.execute(arguments)


def sandbox_tools(
    root: Path,
    names: Sequence[str],
    *,
    repository_explorer: AgentTool | None = None,
) -> tuple[AgentTool, ...]:
    """The named built-in tools, rooted at ``root`` and confined to it.

    Confinement is applied to any tool that declares a ``path`` argument, so a
    tool added later is covered by the same rule instead of needing to be
    remembered here.
    """

    available = {tool.name: tool for tool in create_builtin_tools(root, repository_explorer=repository_explorer)}
    missing = [name for name in names if name not in available]
    if missing:
        raise CaseError(f"unknown tools: {', '.join(sorted(missing))}")
    return tuple(_confine(available[name], root) for name in names)


def _confine(tool: AgentTool, root: Path) -> AgentTool:
    properties = tool.input_schema.get("properties") if isinstance(tool.input_schema, Mapping) else None
    if not isinstance(properties, Mapping) or _PATH_ARGUMENT not in properties:
        return tool
    return ConfinedTool(tool, root)


# -- running ---------------------------------------------------------------- #


class _Collecting:
    """A sink that keeps a copy of every fact it passes on.

    An experiment needs two things from one run: the trace a deployment would
    have sent, and the structured result to score.  Both come from the same
    published facts, so this forwards them and keeps them.
    """

    def __init__(self, downstream: TelemetrySink | None = None) -> None:
        self._downstream = downstream
        self.events: list[TelemetryEvent] = []

    def record(self, event: TelemetryEvent) -> None:
        self.events.append(event)
        publish(self._downstream, event)

    def operations(self) -> list[OperationTelemetry]:
        return [event for event in self.events if isinstance(event, OperationTelemetry)]

    def generations(self) -> list[GenerationTelemetry]:
        return [event for event in self.events if isinstance(event, GenerationTelemetry)]

    def tools(self) -> list[ToolTelemetry]:
        return [event for event in self.events if isinstance(event, ToolTelemetry)]


def _answer_text(output: JsonValue) -> str:
    """The answer a scorer reads, taken from the operation's committed output."""

    if isinstance(output, str):
        return output[:_MAX_ANSWER_CHARS]
    if isinstance(output, Mapping):
        content = output.get("content")
        if isinstance(content, str):
            return content[:_MAX_ANSWER_CHARS]
    return "" if output is None else json.dumps(output, default=str)[:_MAX_ANSWER_CHARS]


async def run_case(
    case: EvalCase,
    provider: ChatProvider,
    *,
    workdir: Path,
    telemetry: TelemetrySink | None = None,
    storage: Storage | None = None,
    allow_writing: bool = False,
    repository_explorer: AgentTool | None = None,
    session_id: str | None = None,
) -> RunOutput:
    """Run one item to a terminal result and describe what it produced.

    ``workdir`` is the run's whole world: fixtures are written into it, the
    tools are rooted in it, and the durable session is kept beside the
    workspace rather than inside it, so the Agent cannot rewrite its own
    history with a relative path.

    What this isolates is the *workspace*: a fresh directory and a fresh
    session per item, with path-taking tools confined to the first (see
    :class:`ConfinedTool`).  What it does not isolate is the machine — ``bash``
    is a shell, and no wrapper can promise what a command does.  That is why
    writing tools are off unless the caller asks for them, and why a case that
    needs them is expected to carry a ``risk`` label and a human's review.
    """

    cwd = workdir / "workspace"
    cwd.mkdir(parents=True, exist_ok=True)
    for name, content in case.files.items():
        target = cwd / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content, encoding="utf-8")

    tools = sandbox_tools(
        cwd, parse_case_tools(case, allow_writing=allow_writing), repository_explorer=repository_explorer
    )
    collector = _Collecting(telemetry)
    owned = storage is None
    opened: Storage = SQLiteStorage(workdir / "session.sqlite") if storage is None else storage
    identifier = session_id or f"eval:{case.id}"
    harness = await Harness.open(identifier, opened, tools=tools, telemetry=collector)
    try:
        lane = await harness.acquire_lane("main")
        await lane.prompt(case.prompt, operation_id=f"{case.id}-1")
        result: OperationResult = await lane.drive(provider)
    finally:
        await harness.close()
        if owned and isinstance(opened, SQLiteStorage):
            opened.close()

    return _summarize(result, collector, session_id=identifier)


def _summarize(result: OperationResult, collector: _Collecting, *, session_id: str) -> RunOutput:
    terminal = next((event for event in reversed(collector.operations()) if event.phase == "terminal"), None)
    usage: dict[str, int | float] = {}
    for generation in collector.generations():
        for key, value in generation.usage.items():
            usage[key] = usage.get(key, 0) + value
    return RunOutput(
        answer=_answer_text(None if terminal is None else terminal.output),
        tool_calls=tuple(
            ToolCallFact(name=event.name, is_error=event.is_error, outcome=event.outcome) for event in collector.tools()
        ),
        terminal_status=result.status,
        generation_count=len(collector.generations()),
        usage=usage,
        unknown_effects=sum(1 for event in collector.generations() if event.outcome == "unknown")
        + sum(1 for event in collector.tools() if event.outcome == "unknown"),
        duration_ms=result.ended_at - result.started_at,
        error_code=result.error_code,
        error_message=result.error_message,
        session_id=session_id,
        operation_id=result.operation_id,
    )


# -- scoring ---------------------------------------------------------------- #


def _case_of(expected_output: object) -> Mapping[str, Any]:
    return expected_output if isinstance(expected_output, Mapping) else {}


def _output_of(output: object) -> Mapping[str, Any]:
    if isinstance(output, Mapping):
        return output
    if isinstance(output, RunOutput):
        return output.as_dict()
    raise CaseError("the experiment output is not a run result")


def terminal_success(*, output: object, expected_output: object = None, **_: Any) -> Evaluation | None:
    """The turn reached a successful terminal state and proved every effect."""

    result = _output_of(output)
    expected = str(_case_of(expected_output).get("terminal_status", "completed"))
    status = str(result.get("terminal_status"))
    if status != expected:
        return Evaluation("terminal_success", 0.0, f"terminal status was {status!r}, expected {expected!r}")
    unknown = result.get("unknown_effects", 0)
    if unknown:
        return Evaluation("terminal_success", 0.0, f"{unknown} effect(s) could not be proven")
    return Evaluation("terminal_success", 1.0, None)


def required_tools(*, output: object, expected_output: object = None, **_: Any) -> Evaluation | None:
    """Every tool the item requires was called at least once.

    A call counts as used however it ended: whether it *worked* is what
    :func:`tool_error_free` scores.
    """

    required = {str(name) for name in _case_of(expected_output).get("required_tools", [])}
    if not required:
        return None
    called = {str(call.get("name")) for call in _calls(output)}
    missing = sorted(required - called)
    if missing:
        return Evaluation("required_tools", 0.0, f"never called: {', '.join(missing)}")
    return Evaluation("required_tools", 1.0, None)


def forbidden_tools(*, output: object, expected_output: object = None, **_: Any) -> Evaluation | None:
    """No tool the item forbids was called, whatever the outcome."""

    forbidden = {str(name) for name in _case_of(expected_output).get("forbidden_tools", [])}
    if not forbidden:
        return None
    violations = sorted(forbidden & {str(call.get("name")) for call in _calls(output)})
    if violations:
        return Evaluation("forbidden_tools", 0.0, f"called: {', '.join(violations)}")
    return Evaluation("forbidden_tools", 1.0, None)


def tool_error_free(*, output: object, expected_output: object = None, **_: Any) -> Evaluation | None:
    """No tool failed, except the ones this item expects to fail."""

    allowed = {str(name) for name in _case_of(expected_output).get("expected_tool_errors", [])}
    failures = sorted(
        {str(call.get("name")) for call in _calls(output) if call.get("is_error") and call.get("name") not in allowed}
    )
    if failures:
        return Evaluation("tool_error_free", 0.0, f"failed: {', '.join(failures)}")
    return Evaluation("tool_error_free", 1.0, None)


def _calls(output: object) -> list[Mapping[str, Any]]:
    calls = _output_of(output).get("tool_calls", [])
    if not isinstance(calls, Sequence) or isinstance(calls, (str, bytes)):
        return []
    return [call for call in calls if isinstance(call, Mapping)]


def answer_contract(*, output: object, expected_output: object = None, **_: Any) -> Evaluation | None:
    """The answer matches the item's textual or JSON contract."""

    contract = _case_of(expected_output).get("answer_contract")
    if not isinstance(contract, Mapping) or not contract:
        return None
    failure = _contract_failure(str(_output_of(output).get("answer", "")), contract)
    if failure:
        return Evaluation("answer_contract", 0.0, failure)
    return Evaluation("answer_contract", 1.0, None)


def _contract_failure(answer: str, contract: Mapping[str, Any]) -> str | None:
    exact = contract.get("exact")
    if isinstance(exact, str) and answer.strip() != exact.strip():
        return f"answer is not the expected text ({len(answer)} chars)"
    contains = contract.get("contains")
    if isinstance(contains, Sequence) and not isinstance(contains, (str, bytes)):
        missing = [repr(str(needle)) for needle in contains if str(needle) not in answer]
        if missing:
            return f"answer is missing {', '.join(missing)}"
    schema = contract.get("schema")
    if contract.get("json") or schema:
        parsed = _parse_json_answer(answer)
        if parsed is None:
            return "answer is not JSON"
        if isinstance(schema, Mapping) and isinstance(parsed, Mapping):
            missing = [str(key) for key in schema.get("required", []) if key not in parsed]
            if missing:
                return f"answer JSON is missing {', '.join(missing)}"
    return None


def _parse_json_answer(answer: str) -> JsonValue | None:
    """The answer as JSON, accepting the fenced block a model usually writes."""

    text = answer.strip()
    if text.startswith("```"):
        lines = text.splitlines()
        body = lines[1:-1] if lines[-1].strip() == "```" else lines[1:]
        text = "\n".join(body).strip()
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        return None


def _budgeted(metric: str, measured: float, budget: object, unit: str) -> Evaluation:
    if not isinstance(budget, int):
        return Evaluation(metric, measured, f"{measured:g} {unit}")
    over = " (over budget)" if measured > budget else ""
    return Evaluation(metric, measured, f"{measured:g} {unit}, budget {budget}{over}")


def tool_count(*, output: object, expected_output: object = None, **_: Any) -> Evaluation | None:
    """How many tools the run called, against the item's budget."""

    calls = _calls(output)
    return _budgeted("tool_count", float(len(calls)), _case_of(expected_output).get("tool_budget"), "call(s)")


def latency(*, output: object, expected_output: object = None, **_: Any) -> Evaluation | None:
    """How long the turn took, against the item's budget."""

    duration = _output_of(output).get("duration_ms")
    if not isinstance(duration, int):
        return None
    return _budgeted("latency", float(duration), _case_of(expected_output).get("latency_budget_ms"), "ms")


def token_cost(*, output: object, expected_output: object = None, **_: Any) -> Evaluation | None:
    """Prompt plus completion tokens the run spent, against the item's budget."""

    usage = _output_of(output).get("usage")
    if not isinstance(usage, Mapping) or not usage:
        return None
    total = sum(float(value) for value in usage.values() if isinstance(value, (int, float)))
    return _budgeted("token_cost", total, _case_of(expected_output).get("token_budget"), "token(s)")


EVALUATORS: Final[dict[str, Callable[..., Evaluation | None]]] = {
    "terminal_success": terminal_success,
    "required_tools": required_tools,
    "forbidden_tools": forbidden_tools,
    "tool_error_free": tool_error_free,
    "answer_contract": answer_contract,
    "tool_count": tool_count,
    "latency": latency,
    "token_cost": token_cost,
}
"""Every scorer by name, so an item can choose and a gate can pin the set."""


def evaluators_for(names: Sequence[str]) -> tuple[Callable[..., Evaluation | None], ...]:
    """The named scorers, in the order the caller asked for them."""

    unknown = [name for name in names if name not in EVALUATORS]
    if unknown:
        raise CaseError(f"unknown evaluators: {', '.join(sorted(unknown))}")
    return tuple(EVALUATORS[name] for name in names)


def run_metrics(results: Sequence[Any]) -> list[Evaluation]:
    """Aggregates over a finished experiment: the numbers a gate compares.

    These are run-level on purpose.  A tool count or a latency is only
    meaningful as a distribution over the dataset, and a gate compares that
    distribution with the baseline run rather than with a per-item constant.
    """

    def values(metric: str) -> list[float]:
        return [
            float(evaluation.value)
            for item in results
            for evaluation in getattr(item, "evaluations", [])
            if evaluation.name == metric and isinstance(evaluation.value, (int, float))
        ]

    metrics: list[Evaluation] = []
    for metric in ("terminal_success", "forbidden_tools", "tool_error_free", "answer_contract"):
        scored = values(metric)
        if scored:
            metrics.append(Evaluation(f"{metric}_rate", sum(scored) / len(scored), f"{len(scored)} item(s)"))
    counts = values("tool_count")
    if counts:
        metrics.append(Evaluation("tool_count_mean", sum(counts) / len(counts), f"max {max(counts):g}"))
    durations = values("latency")
    if durations:
        metrics.append(Evaluation("latency_p95", _percentile(durations, 0.95), f"{len(durations)} item(s)"))
    costs = values("token_cost")
    if costs:
        metrics.append(Evaluation("token_cost_total", sum(costs), f"{len(costs)} item(s)"))
    return metrics


def _percentile(values: Sequence[float], fraction: float) -> float:
    ordered = sorted(values)
    if not ordered:
        return 0.0
    index = min(len(ordered) - 1, max(0, round(fraction * (len(ordered) - 1))))
    return ordered[index]
