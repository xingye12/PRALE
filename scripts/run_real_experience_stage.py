"""Run one real-repository fixture against a supplied PRALE or Claude launcher."""

import argparse
import json
import shlex
from pathlib import Path

from real_experience_eval import load_capsule, run_stage


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capsule", type=Path, required=True)
    parser.add_argument("--fixture", type=Path, required=True)
    parser.add_argument("--episode", required=True)
    parser.add_argument("--stage", choices=("learn", "transfer", "correction", "retransfer"), required=True)
    parser.add_argument("--agent-command", required=True, help="command with an optional {workspace} token")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--timeout", type=float, default=900)
    parser.add_argument("--allow-host-execution", action="store_true")
    args = parser.parse_args()
    result = run_stage(
        capsule=load_capsule(args.capsule),
        fixture=args.fixture,
        agent_command=shlex.split(args.agent_command),
        allow_host_execution=args.allow_host_execution,
        timeout_seconds=args.timeout,
    )
    result.update({"episode": args.episode, "stage": args.stage})
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
