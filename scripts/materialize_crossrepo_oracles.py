"""Turn registered cross-repository task prompts into billable, oracle-backed stages.

Every stage is a hermetic repository task: the agent must inspect real source
and submit structured evidence. The oracle is deliberately outside the agent
workspace and validates task identity, repository-local evidence, delivery
shape, and the additional artifact required by demo/contract/operate modes.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

_PATHS: dict[tuple[str, str], tuple[str, ...]] = {
    ("learn", "01"): (
        "packages/coding-agent/src/core/settings-manager.ts",
        "packages/coding-agent/src/core/resolve-config-value.ts",
    ),
    ("learn", "02"): (
        "packages/coding-agent/src/core/resource-loader.ts",
        "packages/coding-agent/src/core/project-trust.ts",
    ),
    ("learn", "03"): (
        "packages/agent/src/harness/agent-harness.ts",
        "packages/agent/test/harness/execution-tools.test.ts",
    ),
    ("learn", "04"): (
        "packages/agent/test/harness/jsonl-storage.test.ts",
        "packages/agent/test/harness/session-context.test.ts",
    ),
    ("learn", "05"): ("packages/ai/package.json", "scripts/publish-model-catalog.mjs"),
    ("learn", "06"): ("aider/args.py", "aider/main.py"),
    ("learn", "07"): ("aider/repomap.py", "aider/repo.py"),
    ("learn", "08"): ("aider/coders/search_replace.py", "tests/basic/test_editblock.py"),
    ("learn", "09"): ("aider/linter.py", "aider/run_cmd.py"),
    ("learn", "10"): ("aider/models.py", "tests/basic/test_models.py"),
    ("learn", "11"): ("MemoryCore/src/core/index.ts", "sdk/memory-core/typescript/src/client.ts"),
    ("learn", "12"): ("sdk/memory-core/typescript/src/v3/http.ts", "sdk/memory-core/typescript/src/errors.ts"),
    ("learn", "13"): ("MemoryKnowledge/src/store/build-queue.ts", "MemoryKnowledge/src/store/serial-queue.ts"),
    ("learn", "14"): (
        "MemoryKnowledge/src/engines/wiki/ingest-v2/frontmatter.ts",
        "MemoryKnowledge/src/engines/wiki/ingest-v2/chunker.ts",
    ),
    ("learn", "15"): (
        "MemoryPanel/src/panel/kernel/headers.ts",
        "MemoryPanel/src/panel/http/middleware/validate-panel-headers.ts",
    ),
    ("learn", "16"): ("server/core/session-sync.js", "server/core/session-usage-cache.js"),
    ("learn", "17"): ("server/core/multi-tenant-gateway.js", "server/core/request-context.js"),
    ("learn", "18"): ("server/core/config-queue.js", "server/core/config-queue.js"),
    ("learn", "19"): ("server/services/wattclaw-project-runtime.js", "server/services/wattclaw-project-events.js"),
    ("learn", "20"): ("server/utils/generated-file-path.js", "server/gateway-file-transfer.js"),
    ("learn", "21"): ("packages/agent/test/harness/execution-tools.test.ts",),
    ("learn", "22"): ("aider/run_cmd.py",),
    ("learn", "23"): ("MemoryPanel/src/panel/http/app.ts", "MemoryPanel/src/panel/kernel/envelope.ts"),
    ("learn", "24"): ("server/core/session-sync.js",),
    ("learn", "25"): ("packages/ai/package.json",),
    ("learn", "26"): ("aider/args.py",),
    ("learn", "27"): (
        "MemoryKnowledge/src/engines/code/normalize.ts",
        "MemoryKnowledge/src/engines/wiki/ingest-v2/frontmatter.ts",
    ),
    ("learn", "28"): ("server/services/wattclaw-project-runtime.js",),
    ("learn", "29"): ("packages/agent/src/harness/agent-harness.ts",),
    ("learn", "30"): ("MemoryCore/src/core/index.ts", "sdk/memory-core/typescript/src/http.ts"),
    ("transfer", "01"): ("packages/coding-agent/test/settings-manager.test.ts",),
    ("transfer", "02"): ("packages/coding-agent/src/core/resource-loader.ts",),
    ("transfer", "03"): ("packages/agent/test/harness/execution-tools.test.ts",),
    ("transfer", "04"): ("packages/agent/test/harness/session-context.test.ts",),
    ("transfer", "05"): ("scripts/publish-model-catalog.mjs", "packages/ai/package.json"),
    ("transfer", "06"): ("aider/args.py", "tests/basic/test_main.py"),
    ("transfer", "07"): ("aider/repomap.py",),
    ("transfer", "08"): ("aider/coders/search_replace.py",),
    ("transfer", "09"): ("aider/run_cmd.py",),
    ("transfer", "10"): ("aider/models.py",),
    ("transfer", "11"): ("sdk/memory-core/typescript/src/client.ts",),
    ("transfer", "12"): ("sdk/memory-core/typescript/src/v3/metadata-client.ts",),
    ("transfer", "13"): ("MemoryKnowledge/src/store/build-queue.ts",),
    ("transfer", "14"): ("MemoryKnowledge/src/engines/wiki/ingest-v2/slug.ts",),
    ("transfer", "15"): ("MemoryPanel/src/panel/http/middleware/validate-panel-headers.ts",),
    ("transfer", "16"): ("server/core/session-sync.js",),
    ("transfer", "17"): ("server/core/multi-tenant-gateway.js",),
    ("transfer", "18"): ("server/core/config-queue.js",),
    ("transfer", "19"): ("server/services/wattclaw-project-runtime.js",),
    ("transfer", "20"): ("server/utils/generated-file-path.js",),
    ("transfer", "21"): ("tests/basic/test_coder.py",),
    ("transfer", "22"): ("server/core/system.js", "server/core/gateway-client.js"),
    ("transfer", "23"): ("packages/agent/src/proxy.ts",),
    ("transfer", "24"): ("MemoryKnowledge/src/store/build-queue.ts",),
    ("transfer", "25"): ("package.json", "server/index.js"),
    ("transfer", "26"): ("MemoryPanel/src/panel/config/panel-config.ts",),
    ("transfer", "27"): ("server/handlers/files.js", "server/utils/generated-file-path.js"),
    ("transfer", "28"): ("aider/watch.py", "tests/basic/test_watch.py"),
    ("transfer", "29"): ("MemoryCore/src/core/index.ts",),
    ("transfer", "30"): ("aider/sendchat.py", "aider/llm.py"),
}


def _oracle(*, task_id: str, phase: str, repository: str, mode: str, paths: tuple[str, ...]) -> str:
    return f'''"""Hidden oracle for cross-repository task {phase}/{task_id}."""
import json
import sys
from pathlib import Path

TASK_ID = {task_id!r}
PHASE = {phase!r}
REPOSITORY = {repository!r}
MODE = {mode!r}
EXPECTED_PATHS = {paths!r}


def fail(message: str) -> None:
    print(message, file=sys.stderr)
    raise SystemExit(1)


workspace = Path(sys.argv[1])
stage_token = sys.argv[2] if len(sys.argv) == 3 else TASK_ID
if not isinstance(stage_token, str) or not stage_token:
    fail("stage token must be a non-empty string")
result_path = workspace / ".prale-eval" / "result.json"
try:
    result = json.loads(result_path.read_text(encoding="utf-8"))
except (OSError, ValueError) as error:
    fail(f"missing or invalid result.json: {{error}}")
if not isinstance(result, dict):
    fail("result.json must be an object")
for key, expected in (("task_id", stage_token), ("repository", REPOSITORY), ("mode", MODE)):
    if result.get(key) != expected:
        fail(f"{{key}} does not identify this stage")
evidence = result.get("evidence")
if not isinstance(evidence, list):
    fail("evidence must be a list")
evidence_paths = {{
    item.get("path")
    for item in evidence
    if isinstance(item, dict) and isinstance(item.get("path"), str)
}}
if not set(EXPECTED_PATHS).issubset(evidence_paths):
    fail("result omits required repository-local evidence")
for path in EXPECTED_PATHS:
    if not (workspace / path).is_file():
        fail(f"expected source evidence is absent: {{path}}")
for item in evidence:
    if not isinstance(item, dict):
        continue
    if item.get("path") in EXPECTED_PATHS:
        if not isinstance(item.get("symbol"), str) or not item["symbol"].strip():
            fail("required evidence has no symbol")
        if not isinstance(item.get("observation"), str) or len(item["observation"].strip()) < 20:
            fail("required evidence has no substantive observation")
        start_line, end_line = item.get("start_line"), item.get("end_line")
        if not isinstance(start_line, int) or not isinstance(end_line, int) or start_line < 1 or end_line < start_line:
            fail("required evidence has an invalid line range")
        lines = (workspace / item["path"]).read_text(encoding="utf-8", errors="replace").splitlines()
        if end_line > len(lines):
            fail("required evidence line range is outside the cited file")
        excerpt = "\\n".join(lines[start_line - 1 : end_line])
        if item["symbol"] not in excerpt:
            fail("required evidence symbol is not present in the cited line range")
claims = result.get("claims")
if not isinstance(claims, list) or len(claims) < len(EXPECTED_PATHS):
    fail("result must contain one grounded claim per required evidence path")
for claim in claims:
    if not isinstance(claim, dict) or not isinstance(claim.get("claim"), str) or len(claim["claim"].strip()) < 40:
        fail("claim is missing or not substantive")
    cited_paths = claim.get("evidence_paths")
    if not isinstance(cited_paths, list) or not cited_paths or not all(isinstance(path, str) for path in cited_paths):
        fail("claim must name one or more evidence paths")
    if not set(cited_paths).issubset(evidence_paths):
        fail("claim cites evidence that is absent from result")
if not isinstance(result.get("conclusion"), str) or len(result["conclusion"].strip()) < 80:
    fail("conclusion must explain the repository-specific result")
validation = result.get("validation")
if not isinstance(validation, dict):
    fail("validation must record command, status, and notes")
for key in ("command", "status", "notes"):
    if not isinstance(validation.get(key), str) or not validation[key].strip():
        fail("validation must record command, status, and notes")
if MODE != "explore":
    artifact = workspace / ".prale-eval" / f"{{MODE}}-deliverable.md"
    try:
        content = artifact.read_text(encoding="utf-8")
    except OSError as error:
        fail(f"missing {{MODE}} deliverable: {{error}}")
    if len(content.strip()) < 80:
        fail(f"{{MODE}} deliverable is not substantive")
print("acceptance passed")
'''


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fixtures", type=Path, default=Path("evals/experience-crossrepo-v1/fixtures"))
    args = parser.parse_args()
    count = 0
    for phase in ("learn", "transfer"):
        for index in range(1, 31):
            task_id = f"{index:02d}"
            fixture = args.fixtures / phase / task_id
            metadata_path = fixture / "fixture.json"
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            paths = _PATHS[(phase, task_id)]
            (fixture / "oracle.py").write_text(
                _oracle(
                    task_id=task_id,
                    phase=phase,
                    repository=metadata["repository"],
                    mode=metadata["mode"],
                    paths=paths,
                ),
                encoding="utf-8",
            )
            task_path = fixture / "TASK.md"
            task = task_path.read_text(encoding="utf-8")
            evidence_start = "<!-- crossrepo-evidence-contract:start -->"
            evidence_end = "<!-- crossrepo-evidence-contract:end -->"
            evidence_contract = "\n".join(
                [
                    "",
                    evidence_start,
                    "## Required source evidence",
                    "",
                    "Your `evidence` array must include one substantive entry for each of these "
                    "repository-relative files:",
                    *[f"- `{path}`" for path in paths],
                    "",
                    "For each entry, name a real symbol, give an inclusive `start_line`/`end_line` range "
                    "that contains that symbol, and explain its task-relevant behavior. Add at least one "
                    "substantive `claims` item per required path; each claim must name the paths in its "
                    "`evidence_paths`. These files are the public acceptance contract; the oracle checks "
                    "that citations, symbols, line ranges and grounded claims are present.",
                    evidence_end,
                    "",
                ]
            )
            marker = "\nThe acceptance oracle is hidden."
            if marker not in task:
                raise ValueError(f"task prompt has no acceptance marker: {task_path}")
            if evidence_start not in task:
                task_path.write_text(task.replace(marker, evidence_contract + marker), encoding="utf-8")
            metadata["status"] = "ready"
            metadata["oracle_version"] = 2
            metadata["expected_evidence_count"] = len(paths)
            metadata_path.write_text(
                json.dumps(metadata, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            count += 1
    print(f"materialized {count} ready fixtures")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
