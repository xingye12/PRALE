"""Build an independent real-v3 corpus without injected source comments."""

import argparse
import difflib
import json
import tarfile
from pathlib import Path

import build_real_experience_advanced as advanced
import build_real_experience_fixtures as basic

REPO = Path(__file__).resolve().parents[1]
ROOT = Path("evals/experience-real-v3")
BENCHMARK_ID = "prale-experience-real-v3"


def mutate(source: str, before: str, after: str) -> str:
    """Remove deleted statements outright instead of leaving fault annotations."""
    if source.count(before) != 1:
        raise ValueError("mutation anchor must be unique")
    if after.strip().startswith("//"):
        anchor = before.strip()
        lines = source.splitlines(keepends=True)
        matching = [i for i, line in enumerate(lines) if anchor in line]
        if len(matching) != 1:
            raise ValueError("comment replacement must identify one complete statement line")
        del lines[matching[0]]
        return "".join(lines)
    return source.replace(before, after, 1)


def patch_for(faults: tuple[basic.Fixture | advanced.Fault, ...]) -> str:
    patches = []
    with tarfile.open(basic.CAPSULE) as archive:
        for fault in faults:
            member = archive.extractfile(fault.target)
            if member is None:
                raise ValueError(f"missing source: {fault.target}")
            source = member.read().decode()
            mutated = mutate(source, fault.before, fault.after)
            patch = "".join(
                difflib.unified_diff(
                    source.splitlines(keepends=True),
                    mutated.splitlines(keepends=True),
                    fromfile=f"a/{fault.target}",
                    tofile=f"b/{fault.target}",
                )
            )
            original_comments = {line.split("//", 1)[1] for line in source.splitlines() if "//" in line}
            if any("//" in line and line.split("//", 1)[1] not in original_comments for line in mutated.splitlines()):
                raise ValueError("v3 mutations must not add source comments")
            patches.append(patch)
    return "".join(patches)


def render() -> dict[Path, str]:
    files = {}
    old_root = Path("evals/experience-real-v2")
    for path, content in {**basic.render(), **advanced.render()}.items():
        target = ROOT / path.relative_to(old_root)
        if path.name == "mutation.patch":
            continue
        content = content.replace("real-v2", "real-v3").replace("Real-v2", "Real-v3")
        if path.name in {"fixture.json", "benchmark.json"}:
            metadata = json.loads(content)
            metadata.update(benchmark_id=BENCHMARK_ID, fixture_revision=1)
            content = json.dumps(metadata, indent=2, ensure_ascii=False, sort_keys=True) + "\n"
        files[target] = content
    for fixture in basic.FIXTURES:
        files[ROOT / "fixtures" / fixture.episode / fixture.stage / "mutation.patch"] = patch_for((fixture,))
    for fixture in advanced.FIXTURES:
        files[ROOT / "advanced/fixtures" / fixture.episode / fixture.stage / "mutation.patch"] = patch_for(
            fixture.faults
        )
    capsule = json.loads((basic.CAPSULE.parent / "capsule.json").read_text())
    capsule.update(
        benchmark_id=BENCHMARK_ID, source_archive="../../../experience-real-v2/capsules/pi-b455975/source.tar"
    )
    files[ROOT / "capsules/pi-b455975/capsule.json"] = json.dumps(capsule, indent=2, sort_keys=True) + "\n"
    benchmark = json.loads((REPO / old_root / "benchmark.json").read_text())
    benchmark.update(
        benchmark_id=BENCHMARK_ID,
        version=3,
        fixture_revision=1,
        public_support_version=1,
        task_count=12,
        protocol_document="specs/real-v3-comment-free-injection.md",
    )
    benchmark["acceptance"]["protocol"] = "specs/real-v3-comment-free-injection.md"
    files[ROOT / "benchmark.json"] = json.dumps(benchmark, indent=2, ensure_ascii=False) + "\n"
    files[ROOT / "fixtures/.gitattributes"] = "*.patch -whitespace\n"
    return files


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    files = render()
    if args.check:
        return int(
            any(not (REPO / path).is_file() or (REPO / path).read_text() != content for path, content in files.items())
        )
    for path, content in files.items():
        target = REPO / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
