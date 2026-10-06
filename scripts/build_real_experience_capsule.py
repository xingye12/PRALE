"""Create a frozen real-repository capsule from a committed checkout."""

import argparse
from pathlib import Path

from real_experience_eval import build_capsule


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository-root", type=Path, default=Path("/root/vibe/CoLe/pi"))
    parser.add_argument("--pi-root", type=Path, dest="repository_root", help=argparse.SUPPRESS)
    parser.add_argument("--repository", default="earendil-works/pi")
    parser.add_argument("--benchmark-id", default="prale-experience-real-v2")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--container-image", required=True)
    args = parser.parse_args()
    capsule = build_capsule(
        repository_root=args.repository_root,
        output=args.output,
        container_image=args.container_image,
        benchmark_id=args.benchmark_id,
        repository=args.repository,
    )
    print(f"wrote {args.output / 'capsule.json'} at {capsule.base_commit}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
