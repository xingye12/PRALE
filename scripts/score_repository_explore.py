"""Score paired repository-exploration file coverage without a provider or LLM judge."""

import argparse
import json
from pathlib import Path

from repository_explore_scoring import compare_reports


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tasks", type=Path, default=Path("evals/repository_explore/tasks.json"))
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--treatment", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        payload = compare_reports(
            *(json.loads(path.read_text(encoding="utf-8")) for path in (args.tasks, args.baseline, args.treatment))
        )
    except (ValueError, KeyError, TypeError, OSError) as error:
        parser.error(str(error))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(payload["summary"], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
