"""Hidden oracle for cross-repository task transfer/01."""
import json
import sys
from pathlib import Path

TASK_ID = '01'
PHASE = 'transfer'
REPOSITORY = 'pi'
MODE = 'contract'
EXPECTED_PATHS = ('packages/coding-agent/test/settings-manager.test.ts',)


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
    fail(f"missing or invalid result.json: {error}")
if not isinstance(result, dict):
    fail("result.json must be an object")
for key, expected in (("task_id", stage_token), ("repository", REPOSITORY), ("mode", MODE)):
    if result.get(key) != expected:
        fail(f"{key} does not identify this stage")
evidence = result.get("evidence")
if not isinstance(evidence, list):
    fail("evidence must be a list")
evidence_paths = {
    item.get("path")
    for item in evidence
    if isinstance(item, dict) and isinstance(item.get("path"), str)
}
if not set(EXPECTED_PATHS).issubset(evidence_paths):
    fail("result omits required repository-local evidence")
for path in EXPECTED_PATHS:
    if not (workspace / path).is_file():
        fail(f"expected source evidence is absent: {path}")
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
        excerpt = "\n".join(lines[start_line - 1 : end_line])
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
    artifact = workspace / ".prale-eval" / f"{MODE}-deliverable.md"
    try:
        content = artifact.read_text(encoding="utf-8")
    except OSError as error:
        fail(f"missing {MODE} deliverable: {error}")
    if len(content.strip()) < 80:
        fail(f"{MODE} deliverable is not substantive")
print("acceptance passed")
