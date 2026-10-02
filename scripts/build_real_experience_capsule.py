"""Create a frozen real-repository capsule from a committed pi checkout."""

import argparse
from pathlib import Path

from real_experience_eval import build_capsule


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pi-root", type=Path, default=Path("/root/vibe/CoLe/pi"))
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--container-image", required=True)
    args = parser.parse_args()
    capsule = build_capsule(repository_root=args.pi_root, output=args.output, container_image=args.container_image)
    print(f"wrote {args.output / 'capsule.json'} at {capsule.base_commit}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
