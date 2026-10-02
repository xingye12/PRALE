"""Build the dependency-hydrated, network-isolated runtime image for one capsule."""

import argparse
import json
import subprocess
from pathlib import Path
from typing import Any

from real_experience_eval import load_capsule


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capsule", type=Path, required=True)
    parser.add_argument("--tag", required=True)
    args = parser.parse_args()
    capsule = load_capsule(args.capsule)
    dockerfile = Path("evals/experience-real-v2/Dockerfile").resolve()
    completed = subprocess.run(
        [
            "docker",
            "build",
            "--network",
            "default",
            "--build-arg",
            f"BASE_IMAGE={capsule.container_image}",
            "--tag",
            args.tag,
            "--file",
            str(dockerfile),
            str(capsule.source_archive.parent),
        ],
        check=False,
    )
    if completed.returncode:
        return completed.returncode
    inspected = subprocess.run(
        ["docker", "image", "inspect", args.tag, "--format", "{{.Id}}"],
        capture_output=True,
        text=True,
        check=True,
    )
    value: dict[str, Any] = json.loads(args.capsule.read_text(encoding="utf-8"))
    value["runtime_image"] = {"tag": args.tag, "image_id": inspected.stdout.strip(), "network_at_run": "disabled"}
    args.capsule.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(inspected.stdout.strip())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
