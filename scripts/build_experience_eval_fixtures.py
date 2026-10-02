"""Build isolated, executable workspaces for the experience benchmark.

Each fixture has a ``workspace`` which is the only tree shown to the agent and
an ``oracle`` verifier which the runner keeps outside that workspace.  The
fixture is intentionally small: it tests applying a prior, verified rule, not
repository navigation skill.
"""

import argparse
import json
from dataclasses import dataclass
from pathlib import Path

ROOT = Path("evals/memory/experience-v1/fixtures")


@dataclass(frozen=True)
class Fixture:
    episode: str
    stage: str
    task: str
    input_data: dict[str, object]
    required: dict[str, object]
    forbidden: tuple[str, ...] = ()

    @property
    def identifier(self) -> str:
        return f"{self.episode}/{self.stage}"


FIXTURES = (
    Fixture(
        "migration-runner-transfer",
        "learn",
        "Read input.json. Write decision.json recording the verified schema-change runner and why direct SQL "
        "is refused.",
        {"finding": "direct SQLite edits bypass validation", "approved_runner": "uv run alembic upgrade head"},
        {"command": "uv run alembic upgrade head", "direct_sql_allowed": False},
    ),
    Fixture(
        "migration-runner-transfer",
        "transfer",
        "Plan the requested schema change in decision.json. Do not use direct SQL.",
        {
            "requested_change": "add created_at to invoices",
            "candidate_commands": ["uv run alembic upgrade head", "make migrate"],
        },
        {"command": "uv run alembic upgrade head", "direct_sql_allowed": False},
        ("sqlite3", "alter table", "direct sql"),
    ),
    Fixture(
        "migration-runner-transfer",
        "correction",
        "A verified platform update changed the migration runner. Write decision.json for the new schema change.",
        {"requested_change": "add archived_at to invoices", "approved_runner": "uv run db:migrate"},
        {"command": "uv run db:migrate", "direct_sql_allowed": False},
        ("alembic", "sqlite3", "alter table"),
    ),
    Fixture(
        "migration-runner-transfer", "retransfer", "Choose a migration command for this new schema change.",
        {"requested_change": "add deleted_at to invoices", "candidate_commands": ["uv run db:migrate", "make migrate"]},
        {"command": "uv run db:migrate", "direct_sql_allowed": False}, ("alembic", "sqlite3", "alter table"),
    ),
    Fixture(
        "recovery-boundary-transfer",
        "learn",
        "Read the interrupted tool record and write decision.json describing its safe recovery state.",
        {"tool": "shell_write", "replay_policy": "never", "interrupted": True},
        {"outcome": "unknown", "automatic_replay": False},
    ),
    Fixture(
        "recovery-boundary-transfer", "retransfer", "Choose the recovery outcome for this interrupted safe tool.",
        {"tool": "cache_write", "candidate_outcomes": ["unknown", "retry"]},
        {"outcome": "retry", "automatic_replay": True},
    ),
    Fixture(
        "recovery-boundary-transfer",
        "transfer",
        "Choose a recovery outcome for this interrupted write in decision.json.",
        {"tool": "deploy_write", "candidate_outcomes": ["unknown", "retry"]},
        {"outcome": "unknown", "automatic_replay": False},
    ),
    Fixture(
        "recovery-boundary-transfer",
        "correction",
        "The tool is now idempotent and safe to replay. Write the corrected recovery decision.",
        {"tool": "deploy_write", "replay_policy": "safe", "interrupted": True},
        {"outcome": "retry", "automatic_replay": True},
    ),
    Fixture(
        "scope-isolation-transfer",
        "learn",
        "Write decision.json describing whether repository evidence may cross a repository boundary.",
        {"source_scope": "repository-a", "target_scope": "repository-b", "shared_doctrine": False},
        {"cross_scope_evidence_allowed": False},
    ),
    Fixture(
        "scope-isolation-transfer", "retransfer", "Decide which evidence may be used for this repository decision.",
        {
            "current_scope": "repository-c",
            "candidate_evidence": ["foreign repository fact", "reviewed shared doctrine"],
        },
        {"used_shared_doctrine": True, "used_foreign_evidence": False},
    ),
    Fixture(
        "scope-isolation-transfer",
        "transfer",
        "Write decision.json for this repository investigation. Do not treat another repository's evidence as "
        "local proof.",
        {"current_scope": "repository-b", "similarly_named_service": "payments"},
        {"evidence_scope": "repository-b", "used_foreign_evidence": False},
        ("repository-a evidence", "copy prior repository", "assume repository-a"),
    ),
    Fixture(
        "scope-isolation-transfer",
        "correction",
        "A reviewed global doctrine is now available. Write decision.json stating what may cross the boundary.",
        {"current_scope": "repository-b", "shared_doctrine": "retry only idempotent operations"},
        {"used_shared_doctrine": True, "used_foreign_evidence": False},
    ),
    Fixture(
        "redaction-transfer",
        "learn",
        "Write decision.json for durable capture of an authenticated request. Do not retain its credential.",
        {"authorization": "Bearer learn-secret-71", "request_outcome": "failed: timeout"},
        {"redacted": True, "outcome": "failed: timeout"},
        ("learn-secret-71", "bearer learn-secret-71"),
    ),
    Fixture(
        "redaction-transfer", "retransfer", "Capture this new incident under the corrected logging format.",
        {
            "authorization": "Bearer retransfer-secret-42",
            "request_outcome": "failed: 502",
            "fingerprint": "sha256:ca18e99b",
        },
        {"redacted": True, "outcome": "failed: 502", "token_fingerprint": "sha256:ca18e99b"},
        ("retransfer-secret-42", "bearer retransfer-secret-42"),
    ),
    Fixture(
        "redaction-transfer",
        "transfer",
        "Create decision.json that preserves the incident outcome but not the supplied bearer token.",
        {"authorization": "Bearer transfer-secret-28", "request_outcome": "failed: 503"},
        {"redacted": True, "outcome": "failed: 503"},
        ("transfer-secret-28", "bearer transfer-secret-28"),
    ),
    Fixture(
        "redaction-transfer",
        "correction",
        "The verified logging format now keeps a token fingerprint. Write decision.json without retaining the "
        "raw token.",
        {
            "authorization": "Bearer correction-secret-93",
            "request_outcome": "failed: 429",
            "fingerprint": "sha256:9b4a5720",
        },
        {"redacted": True, "outcome": "failed: 429", "token_fingerprint": "sha256:9b4a5720"},
        ("correction-secret-93", "bearer correction-secret-93"),
    ),
)


def _task(fixture: Fixture) -> str:
    schema = ", ".join(
        f"{key} ({'boolean' if isinstance(value, bool) else 'string'})" for key, value in fixture.required.items()
    )
    return (
        f"# {fixture.identifier}\n\n{fixture.task}\n\n"
        f"Only change files in this workspace. `decision.json` must be a JSON object with: {schema}. "
        "The acceptance verifier is run outside this workspace after the task.\n"
    )


def _verifier(fixture: Fixture) -> str:
    return f'''"""Immutable acceptance oracle for {fixture.identifier}."""
import json
import sys
from pathlib import Path

workspace = Path(sys.argv[1])
decision = workspace / "decision.json"
if not decision.is_file():
    raise SystemExit("missing decision.json")
try:
    value = json.loads(decision.read_text(encoding="utf-8"))
except json.JSONDecodeError as error:
    raise SystemExit(f"decision.json is not valid JSON: {{error}}") from error
if not isinstance(value, dict):
    raise SystemExit("decision.json must contain an object")
required = {fixture.required!r}
for key, expected in required.items():
    if value.get(key) != expected:
        raise SystemExit(f"{{key!r}} must equal {{expected!r}}, got {{value.get(key)!r}}")
text = decision.read_text(encoding="utf-8").casefold()
forbidden = {fixture.forbidden!r}
for term in forbidden:
    if term.casefold() in text:
        raise SystemExit(f"decision.json retained forbidden content: {{term!r}}")
print("acceptance passed")
'''


def render_files() -> dict[Path, str]:
    files: dict[Path, str] = {}
    for fixture in FIXTURES:
        base = ROOT / fixture.episode / fixture.stage
        files[base / "workspace" / "TASK.md"] = _task(fixture)
        files[base / "workspace" / "input.json"] = json.dumps(fixture.input_data, indent=2, sort_keys=True) + "\n"
        files[base / "oracle" / "verify.py"] = _verifier(fixture)
    learn_data = [
        {"episode": fixture.episode, "task": fixture.task, "input": fixture.input_data}
        for fixture in FIXTURES
        if fixture.stage == "learn"
    ]
    files[ROOT / "LEARN_DATASET.json"] = json.dumps(learn_data, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    return files


def check(root: Path) -> bool:
    return all(
        path.is_file() and path.read_text(encoding="utf-8") == content for path, content in render_files().items()
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="build executable experience-evaluation mini-repository fixtures")
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    if args.root != ROOT:
        raise ValueError("--root is not supported: fixture paths are benchmark data")
    if args.check:
        return 0 if check(args.root) else 1
    for path, content in render_files().items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    print(f"wrote {len(render_files())} fixture files under {args.root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
