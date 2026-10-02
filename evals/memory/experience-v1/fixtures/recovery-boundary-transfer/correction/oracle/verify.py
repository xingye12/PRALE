"""Immutable acceptance oracle for recovery-boundary-transfer/correction."""
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
    raise SystemExit(f"decision.json is not valid JSON: {error}") from error
if not isinstance(value, dict):
    raise SystemExit("decision.json must contain an object")
required = {'outcome': 'retry', 'automatic_replay': True}
for key, expected in required.items():
    if value.get(key) != expected:
        raise SystemExit(f"{key!r} must equal {expected!r}, got {value.get(key)!r}")
text = decision.read_text(encoding="utf-8").casefold()
forbidden = ()
for term in forbidden:
    if term.casefold() in text:
        raise SystemExit(f"decision.json retained forbidden content: {term!r}")
print("acceptance passed")
