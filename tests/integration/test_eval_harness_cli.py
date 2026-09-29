"""The evaluation CLI: what it runs, what it refuses, and what it reports.

Every test injects a provider, so nothing here reaches a model or Langfuse.
What is asserted is the contract an operator (and a CI gate) depends on: the
exit code, what reaches stdout and stderr, and the report file.

Exit codes are the interface: 0 scored, 1 a gate failed, 2 the run was refused
before it cost anything.  A refusal that still called the model would be worse
than useless, because the dataset's bug would be paid for on every run.
"""

import asyncio
import json
import logging
import os
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import eval_harness
import pytest

from agent_harness.api.settings import Settings
from agent_harness.integrations.evaluation import parse_case
from agent_harness.runtime.generation import AssistantResult, GenerationRequest, ToolCall

FIXTURE = "the readme says: a durable agent runtime."
ANSWER = "The readme describes a durable agent runtime."
API_KEY = "sk-secret-value-for-tests"
REPOSITORY_ID = "git@example.com:owner/repo.git"


class ScriptedProvider:
    """Answers each case the way the dataset expects, keyed by the prompt.

    One instance serves the whole dataset: an experiment runs its items
    concurrently, so a provider that counted calls globally would be wrong.
    """

    model = "scripted"

    def __init__(self) -> None:
        self.requests: list[GenerationRequest] = []
        self._turns: dict[str, int] = {}

    async def generate(self, request: GenerationRequest) -> AssistantResult:
        self.requests.append(request)
        prompt = str(request.messages[0]["content"])
        turn = self._turns.get(request.session_id, 0) + 1
        self._turns[request.session_id] = turn
        if turn == 1:
            path = "absent.md" if "missing" in prompt else "README.md"
            return AssistantResult(
                content="",
                usage={"prompt_tokens": 30, "completion_tokens": 5},
                tool_calls=(ToolCall(f"call-{turn}", "read", {"path": path}),),
            )
        answer = "there is no such file" if "missing" in prompt else ANSWER
        return AssistantResult(content=answer, usage={"prompt_tokens": 20, "completion_tokens": 7})


CASES = [
    {
        "input": {"prompt": "summarise the readme", "files": {"README.md": FIXTURE}, "tools": ["read"]},
        "expected_output": {"required_tools": ["read"], "answer_contract": {"contains": ["durable"]}},
        "metadata": {"id": "readme"},
    },
    {
        "input": {"prompt": "read the missing file", "tools": ["read"]},
        "expected_output": {"required_tools": ["read"], "expected_tool_errors": ["read"]},
        "metadata": {"id": "missing"},
    },
]


@pytest.fixture(autouse=True)
def _environment(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """A deployment's environment, without a connection to anything."""

    monkeypatch.setenv("PRALE_REPOSITORY_ID", REPOSITORY_ID)
    monkeypatch.setenv("PRALE_API_KEY", API_KEY)
    monkeypatch.setenv("PRALE_PROJECT_ROOT", str(tmp_path / "project"))
    monkeypatch.setenv("PRALE_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.delenv("LANGFUSE_TRACING_ENABLED", raising=False)


@pytest.fixture
def dataset(tmp_path: Path) -> Path:
    path = tmp_path / "dataset.json"
    path.write_text(json.dumps(CASES), encoding="utf-8")
    return path


@pytest.fixture
def report_path(tmp_path: Path) -> Path:
    return tmp_path / "report.json"


def _report(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def test_a_local_dataset_runs_is_scored_and_is_reported(
    dataset: Path, tmp_path: Path, capsys: pytest.CaptureFixture
) -> None:
    provider = ScriptedProvider()
    report = tmp_path / "report.json"

    code = eval_harness.main(
        ["--from-json", str(dataset), "--report", str(report), "--gate", "terminal_success_rate=1"],
        provider=provider,
    )

    printed = capsys.readouterr().out
    assert code == 0
    assert "evaluation plan" in printed
    assert "writing tools      refused" in printed
    # One turn per item per round: two items, two rounds each, on four distinct
    # session ids — each item is its own Agent session.
    assert len(provider.requests) == 4
    assert {request.session_id for request in provider.requests} == {"eval:readme", "eval:missing"}

    payload = _report(report)
    assert [item["id"] for item in payload["items"]] == ["readme", "missing"]
    assert payload["run_name"] is None  # nothing was uploaded, so nothing was named
    by_name = {metric["name"]: metric for metric in payload["metrics"]}
    assert by_name["terminal_success_rate"]["value"] == 1.0
    assert "readme" in printed and "missing" in printed


def test_the_report_carries_what_each_item_was_scored_on(dataset: Path, tmp_path: Path) -> None:
    report = tmp_path / "report.json"

    eval_harness.main(["--from-json", str(dataset), "--report", str(report)], provider=ScriptedProvider())

    [readme, missing] = _report(report)["items"]
    scores = {evaluation["name"]: evaluation["value"] for evaluation in readme["evaluations"]}
    assert scores["terminal_success"] == 1.0
    assert scores["required_tools"] == 1.0
    assert scores["answer_contract"] == 1.0
    assert readme["output"]["answer"] == ANSWER
    assert [call["name"] for call in readme["output"]["tool_calls"]] == ["read"]
    # The item that expected a failure scores it as a pass; the same tool
    # failure would have scored 0 on the item that did not.
    assert missing["output"]["tool_calls"][0]["is_error"] is True
    assert {evaluation["name"]: evaluation["value"] for evaluation in missing["evaluations"]}["tool_error_free"] == 1.0


def test_the_plan_is_printed_before_anything_has_been_spent(
    dataset: Path, tmp_path: Path, capsys: pytest.CaptureFixture
) -> None:
    provider = ScriptedProvider()
    report = tmp_path / "report.json"

    code = eval_harness.main(["--from-json", str(dataset), "--report", str(report), "--dry-run"], provider=provider)

    printed = capsys.readouterr().out
    assert code == 0
    assert "cases              2" in printed
    assert "api_key            <set>" in printed
    assert "tracing            off" in printed
    # A dry run is a plan, not a rehearsal: no model call, no report.
    assert provider.requests == []
    assert not report.exists()


def test_a_gate_is_the_only_thing_that_makes_a_scored_run_fail(dataset: Path, capsys: pytest.CaptureFixture) -> None:
    code = eval_harness.main(["--from-json", str(dataset)], provider=ScriptedProvider())
    assert code == 0

    code = eval_harness.main(
        ["--from-json", str(dataset), "--gate", "terminal_success_rate=2"], provider=ScriptedProvider()
    )

    assert code == 1
    assert "gate failed: terminal_success_rate=1 is below 2" in capsys.readouterr().err


@pytest.mark.parametrize("gate", ["terminal_success_rate", "=1", "terminal_success_rate=many"])
def test_an_unreadable_gate_is_refused_before_anything_runs(
    gate: str, dataset: Path, capsys: pytest.CaptureFixture
) -> None:
    # A broken check that exits 0 is worse than no check at all, and one that
    # exits 0 only after paying for the dataset is worse still.
    provider = ScriptedProvider()

    code = eval_harness.main(["--from-json", str(dataset), "--gate", gate], provider=provider)

    assert code == 2
    assert "metric=value" in capsys.readouterr().err
    assert provider.requests == []


def test_a_gate_on_a_metric_the_run_never_produced_is_refused(
    dataset: Path, tmp_path: Path, capsys: pytest.CaptureFixture
) -> None:
    # ``latency_p99`` reads like a metric this harness has; it is not one, and a
    # gate on it would pass every run forever.  The run itself is not wasted:
    # its report is written before the gate is read.
    report = tmp_path / "report.json"

    code = eval_harness.main(
        ["--from-json", str(dataset), "--gate", "latency_p99=1", "--report", str(report)],
        provider=ScriptedProvider(),
    )

    assert code == 2
    assert "latency_p99" in capsys.readouterr().err
    assert [item["id"] for item in _report(report)["items"]] == ["readme", "missing"]


def test_a_dataset_that_cannot_be_read_is_refused_without_calling_the_model(
    tmp_path: Path, capsys: pytest.CaptureFixture
) -> None:
    broken = tmp_path / "broken.json"
    broken.write_text(json.dumps([{"input": {"prompt": ""}}]), encoding="utf-8")
    provider = ScriptedProvider()

    code = eval_harness.main(["--from-json", str(broken)], provider=provider)

    captured = capsys.readouterr()
    assert code == 2
    assert "evaluation error" in captured.err
    # Nothing ran, and the plan was never printed: there is no partially
    # executed dataset to reason about.
    assert provider.requests == []
    assert "evaluation plan" not in captured.out


def test_duplicate_case_ids_are_refused(tmp_path: Path) -> None:
    # Two items under one id would be two scores for one name in the run
    # metrics, which is a dataset bug rather than a result.
    path = tmp_path / "duplicates.json"
    path.write_text(json.dumps([{"input": {"prompt": "x"}, "metadata": {"id": "same"}}] * 2), encoding="utf-8")

    assert eval_harness.main(["--from-json", str(path)], provider=ScriptedProvider()) == 2


def test_an_empty_dataset_is_refused(tmp_path: Path) -> None:
    path = tmp_path / "empty.json"
    path.write_text("[]", encoding="utf-8")

    assert eval_harness.main(["--from-json", str(path)], provider=ScriptedProvider()) == 2


def test_an_unknown_scorer_is_refused(tmp_path: Path, dataset: Path) -> None:
    assert (
        eval_harness.main(
            ["--from-json", str(dataset), "--evaluators", "terminal_success,latency_p99"], provider=ScriptedProvider()
        )
        == 2
    )


def test_a_case_that_wants_a_writing_tool_needs_the_flag(tmp_path: Path, capsys: pytest.CaptureFixture) -> None:
    path = tmp_path / "writing.json"
    path.write_text(
        json.dumps([{"input": {"prompt": "tidy the readme", "tools": ["read", "bash"]}, "metadata": {"id": "tidy"}}]),
        encoding="utf-8",
    )
    provider = ScriptedProvider()

    code = eval_harness.main(["--from-json", str(path)], provider=provider)

    assert code == 2
    assert "allow_writing" in capsys.readouterr().err
    assert provider.requests == []

    # The same dataset is planned once the operator says so, and the plan names
    # the cases that asked for it.
    code = eval_harness.main(["--from-json", str(path), "--allow-writing", "--dry-run"], provider=provider)

    assert code == 0
    assert "cases needing them tidy" in capsys.readouterr().out


def test_the_limit_runs_only_the_first_cases(dataset: Path, capsys: pytest.CaptureFixture) -> None:
    provider = ScriptedProvider()

    code = eval_harness.main(["--from-json", str(dataset), "--limit", "1"], provider=provider)

    assert code == 0
    assert {request.session_id for request in provider.requests} == {"eval:readme"}
    assert "missing" not in capsys.readouterr().out


def test_a_missing_credential_is_refused(monkeypatch: pytest.MonkeyPatch, dataset: Path) -> None:
    monkeypatch.delenv("PRALE_API_KEY")

    assert eval_harness.main(["--from-json", str(dataset)]) == 2


def test_publishing_a_dataset_needs_the_tracing_configuration(dataset: Path, capsys: pytest.CaptureFixture) -> None:
    # ``--dataset`` reads its items from Langfuse and uploads the run, so a
    # deployment with tracing off is refused before anything is read.
    code = eval_harness.main(["--dataset", "prale/harness-regression"], provider=ScriptedProvider())

    assert code == 2
    assert "LANGFUSE_TRACING_ENABLED" in capsys.readouterr().err


def test_exactly_one_source_of_items(dataset: Path) -> None:
    # argparse owns this one: the two modes write in different places, and
    # "whichever came last" would silently decide an experiment's provenance.
    with pytest.raises(SystemExit):
        eval_harness.main(["--from-json", str(dataset), "--dataset", "prale/x"])
    with pytest.raises(SystemExit):
        eval_harness.main([])


# -- the fixed set, uploaded once -------------------------------------------- #


class _Missing(Exception):
    """Stands in for the SDK's error for a dataset that is not there yet."""

    status_code = 404


class RecordingClient:
    """The slice of a Langfuse client an upload touches, with nothing behind it."""

    def __init__(self, *, exists: bool = False) -> None:
        self.items: list[dict[str, Any]] = []
        self.created: list[str] = []
        self._exists = exists

    def get_dataset(self, name: str) -> Any:
        if not self._exists:
            raise _Missing(f"dataset {name} does not exist")
        return SimpleNamespace(name=name)

    def create_dataset(self, *, name: str, description: str | None = None) -> Any:
        self.created.append(name)
        self._exists = True
        return SimpleNamespace(name=name)

    def create_dataset_item(self, **item: Any) -> Any:
        self.items.append(item)
        return SimpleNamespace(**item)


@pytest.fixture
def uploaded(monkeypatch: pytest.MonkeyPatch, dataset: Path) -> tuple[RecordingClient, Path]:
    """An upload target that is reachable without a Langfuse anywhere."""

    monkeypatch.setenv("LANGFUSE_TRACING_ENABLED", "true")
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk-lf-placeholder")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk-lf-placeholder")
    client = RecordingClient()
    monkeypatch.setattr(eval_harness, "_client", lambda config: client)
    return client, dataset


def test_a_file_of_cases_becomes_a_dataset(
    uploaded: tuple[RecordingClient, Path], capsys: pytest.CaptureFixture
) -> None:
    client, path = uploaded
    provider = ScriptedProvider()

    code = eval_harness.main(["--from-json", str(path), "--upload-to", "prale/regression"], provider=provider)

    printed = capsys.readouterr().out
    assert code == 0
    assert client.created == ["prale/regression"]
    # Nothing was scored: an upload is a write, not a run.
    assert provider.requests == []
    assert "uploaded 2 case(s) to prale/regression" in printed
    assert "--dataset prale/regression" in printed


def test_an_uploaded_item_is_what_the_parser_reads_back(uploaded: tuple[RecordingClient, Path]) -> None:
    # The file is the source of truth and Langfuse is where two runs are
    # compared, so what comes back out of the dataset has to be the case that
    # was validated here — not a slightly different one the SDK round-tripped.
    client, path = uploaded

    eval_harness.main(["--from-json", str(path), "--upload-to", "prale/regression"])

    assert [item["id"] for item in client.items] == ["readme", "missing"]
    for item, original in zip(client.items, CASES, strict=True):
        assert parse_case(item) == parse_case(original)


def test_a_dataset_that_is_already_there_is_added_to_rather_than_recreated(
    monkeypatch: pytest.MonkeyPatch, dataset: Path
) -> None:
    monkeypatch.setenv("LANGFUSE_TRACING_ENABLED", "true")
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk-lf-placeholder")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk-lf-placeholder")
    client = RecordingClient(exists=True)
    monkeypatch.setattr(eval_harness, "_client", lambda config: client)

    assert eval_harness.main(["--from-json", str(dataset), "--upload-to", "prale/regression"]) == 0
    assert client.created == []
    assert len(client.items) == 2


def test_a_dry_run_plans_the_upload_and_writes_nothing(
    uploaded: tuple[RecordingClient, Path], capsys: pytest.CaptureFixture
) -> None:
    client, path = uploaded

    code = eval_harness.main(["--from-json", str(path), "--upload-to", "prale/regression", "--dry-run"])

    assert code == 0
    assert "upload to          prale/regression (then stop)" in capsys.readouterr().out
    assert client.items == []
    assert client.created == []


def test_uploading_needs_the_tracing_configuration(
    monkeypatch: pytest.MonkeyPatch, dataset: Path, capsys: pytest.CaptureFixture
) -> None:
    # Without the switch there is no client to write with, and the run says so
    # rather than importing the SDK to find out.
    monkeypatch.delenv("LANGFUSE_TRACING_ENABLED", raising=False)

    code = eval_harness.main(["--from-json", str(dataset), "--upload-to", "prale/regression"])

    assert code == 2
    assert "LANGFUSE_TRACING_ENABLED" in capsys.readouterr().err


class FakeDataset:
    """The dataset an experiment is run over, with no SDK behind it."""

    def __init__(self, client: "ExperimentClient", name: str) -> None:
        self.name = name
        self.items = client.items
        self._client = client

    def run_experiment(self, **arguments: Any) -> Any:
        return self._client.run(**arguments)


class ExperimentClient:
    """A Langfuse client that runs experiments locally.

    The task is driven the way the SDK drives it — one ``asyncio.run`` per
    item, on a loop made and closed for that item — because that is the loop
    behaviour the tracing adapter is written around.
    """

    def __init__(self, items: list[dict[str, Any]]) -> None:
        self.items = [dict(item) for item in items]
        self.runs: list[dict[str, Any]] = []
        self.flushes = 0

    def get_dataset(self, name: str) -> FakeDataset:
        return FakeDataset(self, name)

    def run(self, *, task: Any, evaluators: list[Any], run_evaluators: list[Any], **arguments: Any) -> Any:
        self.runs.append(arguments)
        results = []
        for item in self.items:
            output = asyncio.run(task(item=item))
            evaluations = []
            for evaluator in evaluators:
                produced = evaluator(
                    output=output,
                    expected_output=item.get("expected_output"),
                    input=item.get("input"),
                    metadata=item.get("metadata"),
                )
                if produced is not None:
                    evaluations.append(SimpleNamespace(**dict(produced)))
            trace_id = f"trace-{item['metadata']['id']}"
            results.append(SimpleNamespace(item=item, output=output, evaluations=evaluations, trace_id=trace_id))
        return SimpleNamespace(
            format=lambda: "experiment summary",
            item_results=results,
            run_evaluations=[
                SimpleNamespace(**metric) for evaluator in run_evaluators for metric in evaluator(item_results=results)
            ],
            dataset_run_url="http://langfuse.local/runs/1",
        )

    def flush(self) -> None:
        self.flushes += 1


def test_a_dataset_run_uses_one_client_and_scores_what_it_ran(
    monkeypatch: pytest.MonkeyPatch, report_path: Path, capsys: pytest.CaptureFixture
) -> None:
    # The path an operator takes against a real Langfuse, driven end to end over
    # a fake: the items are read, the experiment is run, and the scores the
    # platform computed are what the report and the gates are made of.
    client = ExperimentClient(CASES)
    built: list[Any] = []
    monkeypatch.setattr(eval_harness, "_client", lambda config: built.append(config) or client)

    code = eval_harness.main(
        ["--dataset", "prale/regression", "--run-name", "sha-abc", "--report", str(report_path)],
        provider=ScriptedProvider(),
    )

    printed = capsys.readouterr().out
    assert code == 0
    assert len(built) == 1  # one client: the items, the run and the sink share it
    assert client.flushes == 1
    assert "experiment summary" in printed
    assert "dataset run: http://langfuse.local/runs/1" in printed

    [run] = client.runs
    assert run["run_name"] == "sha-abc"
    assert run["metadata"]["capture"] == "off"  # tracing was not enabled for this run
    payload = _report(report_path)
    assert payload["run_name"] == "sha-abc"
    assert [item["id"] for item in payload["items"]] == ["readme", "missing"]
    assert payload["items"][0]["trace_id"] == "trace-readme"
    scores = {metric["name"]: metric["value"] for metric in payload["metrics"]}
    assert scores["terminal_success_rate"] == 1.0


def test_the_sink_publishes_through_the_client_the_run_already_has(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    # OpenTelemetry keeps one global tracer provider per process, so a sink
    # that built its own client would export through the first one anyway —
    # and warn about it.  Sharing the client is what keeps a dataset run and
    # its traces in the same project by construction rather than by coincidence.
    monkeypatch.setenv("LANGFUSE_TRACING_ENABLED", "true")
    monkeypatch.setenv("LANGFUSE_PUBLIC_KEY", "pk-lf-placeholder")
    monkeypatch.setenv("LANGFUSE_SECRET_KEY", "sk-lf-placeholder")
    client = ExperimentClient(CASES)

    with caplog.at_level(logging.WARNING):
        sink = eval_harness._telemetry(Settings.from_environment(os.environ), client)
        assert sink is not None
        asyncio.run(sink.aclose())

    assert client.flushes == 1  # the sink flushed the client it was handed
    assert "one global tracer provider" not in caplog.text


def test_uploading_without_a_file_is_refused(capsys: pytest.CaptureFixture) -> None:
    # Two ways to arrive without cases: argparse refuses the one that names no
    # source at all, and the run refuses the one that names a dataset instead —
    # which is a read, and the file being uploaded is the point of the upload.
    with pytest.raises(SystemExit):
        eval_harness.main(["--upload-to", "prale/regression"])

    code = eval_harness.main(["--upload-to", "prale/regression", "--dataset", "prale/other"])

    assert code == 2
    assert "--from-json" in capsys.readouterr().err
