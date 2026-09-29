"""Run a dataset through the real harness and score every item.

    pip install -e .          # or: PYTHONPATH=src python scripts/eval_harness.py
    python scripts/eval_harness.py --dataset prale/harness-regression

Each item gets its own temporary workspace and its own SQLite session, and the
Agent that runs in it is the one a deployment serves: the same Session, the
same Drive, the same tools and the same settlement path.  What comes back is
scored by ``agent_harness.integrations.evaluation``, which reads the facts the
Drive published rather than the model's prose.  With ``--dataset`` the run is
uploaded to Langfuse together with the traces it produced — that mode needs the
``langfuse`` extra and a reachable Langfuse — while ``--from-json`` reads the
same dataset from a file and uploads nothing, which needs neither.

A fixed set is authored as a file and pushed to Langfuse once:

    python scripts/eval_harness.py --from-json dataset.json --upload-to prale/harness-regression
    python scripts/eval_harness.py --dataset prale/harness-regression --run-name "$(git rev-parse --short HEAD)"

``--upload-to`` writes the parsed cases and stops, one item per case id, so
re-uploading the file updates that dataset instead of doubling it.

Configuration is the deployment's own environment (see
``deploy/web.env.example``), parsed by ``agent_harness.api.settings``: the same
``PRALE_MODEL``, ``PRALE_API_KEY`` and tracing variables a server reads, so an
evaluation and a deployment cannot disagree about what they are measuring.

The dataset is a fixture, so a malformed item stops the run before any model
call: scoring a guess about what its author meant would be worse than not
scoring at all.  The same goes for a scorer, a gate or a case that wants a tool
this run will not grant.

Nothing here reaches a writing tool unless ``--allow-writing`` says so, and the
exit code says what happened: 0 scored, 1 a gate failed, 2 the run was refused.
See ``integrations/evaluation.py`` for what a run does and does not isolate.
"""

import argparse
import asyncio
import json
import os
import subprocess
import sys
import tempfile
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
from typing import Any

from agent_harness.api.errors import ProjectConfigError
from agent_harness.api.settings import Settings
from agent_harness.integrations.deepseek import DeepSeekProvider
from agent_harness.integrations.evaluation import (
    CaseError,
    EvalCase,
    Evaluation,
    evaluators_for,
    parse_case,
    parse_case_tools,
    run_case,
    run_metrics,
)
from agent_harness.integrations.langfuse import LangfuseConfig, LangfuseTelemetry
from agent_harness.runtime.generation import ChatProvider
from agent_harness.runtime.telemetry import TelemetrySink, close_telemetry

DETERMINISTIC_EVALUATORS = (
    "terminal_success",
    "required_tools",
    "forbidden_tools",
    "tool_error_free",
    "answer_contract",
)
BUDGET_EVALUATORS = ("tool_count", "latency", "token_cost")
DEFAULT_EVALUATORS = (*DETERMINISTIC_EVALUATORS, *BUDGET_EVALUATORS)
DEFAULT_CONCURRENCY = 4
WRITING_TOOLS = frozenset({"write", "edit", "bash"})


@dataclass
class ScoredItem:
    """One item of a finished run: its output and everything scored from it."""

    case_id: str
    output: Mapping[str, Any]
    evaluations: list[Evaluation] = field(default_factory=list)
    trace_id: str | None = None


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--dataset", help="Langfuse dataset name, for example prale/harness-regression")
    source.add_argument("--from-json", type=Path, help="a local dataset file, for a run that uploads nothing")
    parser.add_argument("--run-name", help="exact dataset run name; defaults to the experiment name and a timestamp")
    parser.add_argument("--evaluators", default=",".join(DEFAULT_EVALUATORS), help="comma-separated scorer names")
    parser.add_argument("--limit", type=int, help="run only the first N items, for a smoke run")
    parser.add_argument("--max-concurrency", type=int, default=DEFAULT_CONCURRENCY)
    parser.add_argument("--allow-writing", action="store_true", help="let a case use write, edit or bash")
    parser.add_argument(
        "--repository-root",
        type=Path,
        help="local Git repository used to materialise input.repository_snapshot commits",
    )
    parser.add_argument(
        "--gate",
        action="append",
        default=[],
        metavar="METRIC=VALUE",
        help="fail when a run metric is below VALUE, for example terminal_success_rate=0.9",
    )
    parser.add_argument("--report", type=Path, help="write the scored run as JSON here")
    parser.add_argument(
        "--upload-to",
        metavar="DATASET",
        help="write the cases of --from-json into this Langfuse dataset and stop, creating it if needed",
    )
    parser.add_argument("--dry-run", action="store_true", help="validate the dataset, print the plan, then stop")
    return parser


# -- the dataset ------------------------------------------------------------ #


def _raw_item(item: Any) -> dict[str, Any]:
    """A dataset item as the parser wants it, whatever the SDK handed us."""

    if isinstance(item, Mapping):
        return dict(item)
    return {
        "input": getattr(item, "input", None),
        "expected_output": getattr(item, "expected_output", None),
        "metadata": getattr(item, "metadata", None),
    }


def _case_id(item: Mapping[str, Any], index: int) -> str:
    metadata = item.get("metadata")
    identifier = metadata.get("id") if isinstance(metadata, Mapping) else None
    return str(identifier) if identifier else f"item-{index + 1}"


def _load_cases(items: Sequence[Any]) -> list[EvalCase]:
    """Parse every item before running any of them."""

    cases: list[EvalCase] = []
    for index, raw in enumerate(items):
        item = _raw_item(raw)
        cases.append(parse_case(item, fallback_id=_case_id(item, index)))
    if not cases:
        raise CaseError("the dataset is empty: there is nothing to score")
    seen: set[str] = set()
    duplicates: set[str] = set()
    for case in cases:
        if case.id in seen:
            duplicates.add(case.id)
        seen.add(case.id)
    if duplicates:
        raise CaseError(f"duplicate case ids: {', '.join(sorted(duplicates))}")
    return cases


def _expected_of(case: EvalCase) -> dict[str, Any]:
    """The expectations as the scorers read them."""

    expected = case.expectations
    return {
        "terminal_status": expected.terminal_status,
        "required_tools": list(expected.required_tools),
        "forbidden_tools": list(expected.forbidden_tools),
        "expected_tool_errors": list(expected.expected_tool_errors),
        "answer_contract": dict(expected.answer_contract),
    }


def _scorers(names: Sequence[str]) -> tuple[Callable[..., Any], ...]:
    return evaluators_for(names)


def _score(case: EvalCase, output: Mapping[str, Any], names: Sequence[str]) -> list[Evaluation]:
    scorers = _scorers(names)
    expected = _expected_of(case)
    return [
        evaluation
        for evaluation in (scorer(output=output, expected_output=expected) for scorer in scorers)
        if evaluation is not None
    ]


# -- the run ---------------------------------------------------------------- #


def _git_sha() -> str:
    try:
        completed = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"], capture_output=True, text=True, timeout=10, check=False
        )
    except (OSError, subprocess.SubprocessError):
        return "unknown"
    return completed.stdout.strip() or "unknown"


def _harness_version() -> str:
    try:
        return version("prale-agent-harness")
    except PackageNotFoundError:
        return "unknown"


def _metadata(settings: Settings, args: argparse.Namespace, evaluators: Sequence[str]) -> dict[str, str]:
    """What a run has to carry for two runs to be comparable."""

    return {
        "git_sha": _git_sha(),
        "harness_version": _harness_version(),
        "provider": "deepseek",
        "model": settings.model,
        "capture": "off" if settings.langfuse is None else settings.langfuse.capture,
        "evaluators": ",".join(evaluators),
        "writing_allowed": "true" if args.allow_writing else "false",
    }


def _plan(settings: Settings, args: argparse.Namespace, cases: Sequence[EvalCase], evaluators: Sequence[str]) -> str:
    risky = [case.id for case in cases if any(tool in WRITING_TOOLS for tool in case.tools)]
    lines = [
        "evaluation plan",
        f"dataset            {args.dataset or args.from_json}",
        f"cases              {len(cases)}",
        f"evaluators         {', '.join(evaluators)}",
        f"provider           deepseek {settings.model} @ {settings.base_url}",
        f"api_key            {'<set>' if settings.api_key else '<unset>'}",
        f"writing tools      {'allowed' if args.allow_writing else 'refused'}",
        f"tracing            {'off' if settings.langfuse is None else settings.langfuse.describe()}",
        f"max concurrency    {args.max_concurrency}",
    ]
    snapshots = [case.repository_snapshot.git_sha for case in cases if case.repository_snapshot is not None]
    if snapshots:
        lines.append(f"repository root    {args.repository_root or '<required to run snapshots>'}")
        lines.append(f"snapshot commits   {len(set(snapshots))}")
    if args.upload_to:
        lines.append(f"upload to          {args.upload_to} (then stop)")
    if risky:
        lines.append(f"cases needing them {', '.join(risky)}")
    return "\n".join(lines)


def _wrapped(function: Callable[..., Evaluation | None]) -> Callable[..., Any]:
    """A scorer in the shape the SDK calls: keywords in, one score or nothing."""

    def evaluator(*, output: Any, expected_output: Any = None, **_: Any) -> Any:
        evaluation = function(output=output, expected_output=expected_output)
        return None if evaluation is None else evaluation.as_dict()

    evaluator.__name__ = function.__name__
    return evaluator


async def _run_local(
    cases: Sequence[EvalCase],
    provider: ChatProvider,
    evaluators: Sequence[str],
    *,
    telemetry: TelemetrySink | None,
    allow_writing: bool,
    repository_root: Path | None,
) -> list[ScoredItem]:
    """Score a dataset that lives in a file: nothing is uploaded."""

    scored: list[ScoredItem] = []
    for case in cases:
        with tempfile.TemporaryDirectory(prefix=f"prale-eval-{case.id}-") as directory:
            output = await run_case(
                case,
                provider,
                workdir=Path(directory),
                telemetry=telemetry,
                allow_writing=allow_writing,
                repository_root=repository_root,
            )
        item = ScoredItem(case_id=case.id, output=output.as_dict())
        item.evaluations = _score(case, item.output, evaluators)
        scored.append(item)
    return scored


def _run_experiment(
    args: argparse.Namespace,
    settings: Settings,
    cases: Sequence[EvalCase],
    provider: ChatProvider,
    evaluators: Sequence[str],
    telemetry: TelemetrySink | None,
    client: Any,
) -> list[ScoredItem]:
    """Run the dataset experiment in Langfuse; the SDK drives its own loop."""

    dataset = client.get_dataset(args.dataset)
    by_id = {case.id: case for case in cases}

    async def task(*, item: Any, **_: Any) -> Mapping[str, Any]:
        case = by_id[_case_id(_raw_item(item), 0)]
        with tempfile.TemporaryDirectory(prefix=f"prale-eval-{case.id}-") as directory:
            output = await run_case(
                case,
                provider,
                workdir=Path(directory),
                telemetry=telemetry,
                allow_writing=args.allow_writing,
                repository_root=args.repository_root,
            )
        if isinstance(telemetry, LangfuseTelemetry):
            # The runner closes its loop when the experiment returns; this
            # item's facts have to become observations before that happens.
            await telemetry.drain()
        return output.as_dict()

    result = dataset.run_experiment(
        name=args.run_name or f"prale-eval {dataset.name}",
        run_name=args.run_name,
        description="Harness evaluation scored from the facts the Drive committed.",
        task=task,
        evaluators=[_wrapped(scorer) for scorer in _scorers(evaluators)],
        run_evaluators=[lambda *, item_results, **_: [metric.as_dict() for metric in run_metrics(item_results)]],
        max_concurrency=args.max_concurrency,
        metadata=_metadata(settings, args, evaluators),
    )
    print(result.format())
    url = getattr(result, "dataset_run_url", None)
    if url:
        print(f"dataset run: {url}")
    client.flush()

    scored: list[ScoredItem] = []
    for item in result.item_results:
        case_id = _case_id(_raw_item(item.item), len(scored))
        scored.append(
            ScoredItem(
                case_id=case_id,
                output=item.output if isinstance(item.output, Mapping) else {},
                evaluations=[
                    Evaluation(name=evaluation.name, value=evaluation.value, comment=evaluation.comment)
                    for evaluation in getattr(item, "evaluations", [])
                ],
                trace_id=getattr(item, "trace_id", None),
            )
        )
    return scored


def _client(config: LangfuseConfig | None) -> Any:
    if config is None:
        raise ProjectConfigError(
            "an experiment and an upload write to Langfuse: set LANGFUSE_TRACING_ENABLED and both "
            "LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY"
        )
    from langfuse import Langfuse

    return Langfuse(
        public_key=config.public_key,
        secret_key=config.secret_key,
        base_url=config.base_url,
        environment=config.environment,
        release=config.release,
    )


def _telemetry(settings: Settings, client: Any | None) -> LangfuseTelemetry | None:
    """The sink this run publishes through, or ``None`` when tracing is off.

    A dataset run hands its own client to the sink instead of letting it build
    a second one: OpenTelemetry installs one global tracer provider per
    process, so a second client would export through the first one's
    configuration — quietly, with a warning telling the operator so.
    """

    config = LangfuseConfig.from_environment(
        os.environ, project_root=str(settings.project_root), secrets=settings.secrets
    )
    return None if config is None else LangfuseTelemetry(config, client=client)


# -- the dataset, written out ----------------------------------------------- #

DATASET_DESCRIPTION = "PRALE harness evaluation cases, uploaded by scripts/eval_harness.py"


def _item_input(case: EvalCase) -> dict[str, Any]:
    """A case as a dataset item's input, in the shape ``parse_case`` reads."""

    value: dict[str, Any] = {"prompt": case.prompt, "files": dict(case.files), "tools": list(case.tools)}
    if case.repository_snapshot is not None:
        value["repository_snapshot"] = {"git_sha": case.repository_snapshot.git_sha}
    return value


def _dataset(client: Any, name: str) -> Any:
    """The named dataset, created if this is the first upload to it.

    A missing dataset comes back as the SDK's own error type, which it does not
    export from anywhere stable, so the status code is what is read here: any
    other failure is a real one and is left for the caller to report.
    """

    try:
        return client.get_dataset(name)
    except Exception as error:  # the SDK's error type is deliberately not imported here
        if getattr(error, "status_code", None) != 404:
            raise
    return client.create_dataset(name=name, description=DATASET_DESCRIPTION)


def _upload(settings: Settings, name: str, cases: Sequence[EvalCase]) -> int:
    """Write the cases into a Langfuse dataset, then stop.

    A case's id is its item id, so uploading the same file again updates that
    dataset rather than doubling it: the file in the repository stays the
    source of truth for what the fixed set is, and Langfuse stays where two
    runs over it are compared.  Nothing is scored here, so no provider is
    built and no turn is traced.
    """

    try:
        client = _client(settings.langfuse)
        dataset = _dataset(client, name)
        for case in cases:
            client.create_dataset_item(
                dataset_name=name,
                id=case.id,
                input=_item_input(case),
                expected_output=_expected_of(case),
                metadata={"id": case.id, "risk": case.risk},
            )
    except ProjectConfigError as error:
        print(f"evaluation error: {error}", file=sys.stderr)
        return 2
    print(f"uploaded {len(cases)} case(s) to {dataset.name}")
    print(f"run them with: --dataset {dataset.name}")
    return 0


# -- output ----------------------------------------------------------------- #


def _gate_spec(gate: str) -> tuple[str, float]:
    """One ``--gate`` as a metric and the floor it must stay above."""

    name, _, wanted = gate.partition("=")
    name = name.strip()
    if not name or not wanted.strip():
        raise CaseError(f"--gate {gate!r} must be written metric=value")
    try:
        return name, float(wanted)
    except ValueError as error:
        raise CaseError(f"--gate {gate!r} must be written metric=value") from error


def _gates(specs: Sequence[tuple[str, float]], metrics: Sequence[Evaluation]) -> list[str]:
    measured = {metric.name: metric.value for metric in metrics}
    failures: list[str] = []
    for name, wanted in specs:
        if name not in measured:
            # A gate on a metric this run never produced can never fire, so a
            # green build would mean nothing.  Refused rather than passed.
            raise CaseError(f"--gate {name!r} is not a metric this run produced")
        if measured[name] < wanted:
            failures.append(f"{name}={measured[name]:g} is below {wanted:g}")
    return failures


def _report(path: Path, args: argparse.Namespace, items: Sequence[ScoredItem], metrics: Sequence[Evaluation]) -> None:
    payload = {
        "dataset": args.dataset or str(args.from_json),
        "run_name": args.run_name,
        "git_sha": _git_sha(),
        "harness_version": _harness_version(),
        "items": [
            {
                "id": item.case_id,
                "output": item.output,
                "trace_id": item.trace_id,
                "evaluations": [evaluation.as_dict() for evaluation in item.evaluations],
            }
            for item in items
        ],
        "metrics": [metric.as_dict() for metric in metrics],
    }
    path.write_text(json.dumps(payload, indent=2, default=str), encoding="utf-8")


def _print_items(items: Sequence[ScoredItem]) -> None:
    for item in items:
        scores = " ".join(f"{evaluation.name}={evaluation.value:g}" for evaluation in item.evaluations)
        print(f"{item.case_id:32} {scores}")
        for evaluation in item.evaluations:
            if evaluation.comment and evaluation.value != 1.0:
                print(f"    {evaluation.name}: {evaluation.comment}")


def main(
    argv: Sequence[str] | None = None,
    *,
    provider: ChatProvider | None = None,
) -> int:
    """Run one experiment.  Returns 0 on success, 1 on a gate, 2 on a refusal."""

    args = _parser().parse_args(argv)
    try:
        settings = Settings.from_environment(os.environ)
        evaluators = [name.strip() for name in args.evaluators.split(",") if name.strip()]
        if args.upload_to and args.from_json is None:
            raise CaseError("--upload-to writes the cases --from-json read; without a file there is nothing to write")
        # One client for the whole run: the items are read with it, the
        # experiment is run with it and the sink publishes through it.
        client: Any | None = None
        if args.from_json is None:
            client = _client(settings.langfuse)
            items = list(client.get_dataset(args.dataset).items)
        else:
            items = json.loads(args.from_json.read_text(encoding="utf-8"))
        cases = _load_cases(items)
        if args.limit:
            cases = cases[: args.limit]
        _scorers(evaluators)  # refuse an unknown scorer before running anything
        gates = [_gate_spec(gate) for gate in args.gate]  # ...and an unreadable gate
        for case in cases:
            # A case that needs a tool this run will not grant is refused here,
            # where it costs nothing, rather than mid-experiment where it would
            # look like the Agent failed to use a tool it never had.
            parse_case_tools(case, allow_writing=args.allow_writing)
        if args.upload_to is None and any(case.repository_snapshot is not None for case in cases):
            if args.repository_root is None:
                raise CaseError("--repository-root is required when a case uses input.repository_snapshot")
    except (ProjectConfigError, CaseError, OSError, ValueError) as error:
        print(f"evaluation error: {error}", file=sys.stderr)
        return 2

    print(_plan(settings, args, cases, evaluators))
    if args.dry_run:
        return 0
    if args.upload_to is not None:
        return _upload(settings, args.upload_to, cases)

    chat = provider or DeepSeekProvider(
        api_key=settings.api_key,
        model=settings.model,
        base_url=settings.base_url,
        timeout_seconds=settings.timeout_seconds,
    )
    telemetry = _telemetry(settings, client)
    try:
        if args.from_json is not None:
            scored = asyncio.run(
                _run_local(
                    cases,
                    chat,
                    evaluators,
                    telemetry=telemetry,
                    allow_writing=args.allow_writing,
                    repository_root=args.repository_root,
                )
            )
        else:
            scored = _run_experiment(args, settings, cases, chat, evaluators, telemetry, client)
    finally:
        asyncio.run(close_telemetry(telemetry))

    _print_items(scored)
    metrics = run_metrics(scored)
    print("\nrun metrics")
    for metric in metrics:
        print(f"    {metric.name:24} {metric.value:>10g}  {metric.comment or ''}")
    if args.report is not None:
        # Written before the gates are read: the run happened, and a gate that
        # turns out to be unusable must not throw away its scores.
        _report(args.report, args, scored, metrics)
    try:
        failures = _gates(gates, metrics)
    except CaseError as error:
        print(f"evaluation error: {error}", file=sys.stderr)
        return 2
    for failure in failures:
        print(f"gate failed: {failure}", file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
