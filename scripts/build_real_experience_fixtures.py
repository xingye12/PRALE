"""Build version-3 behavioral fixtures against the committed pi capsule.

Only TASK.md and the public subject loader enter the agent workspace. Hidden
contracts, fault patches and oracle metadata stay beside that workspace.
"""

import argparse
import difflib
import json
import tarfile
from dataclasses import dataclass
from pathlib import Path

ROOT = Path("evals/experience-real-v2/fixtures")
REPO = Path(__file__).resolve().parents[1]
CAPSULE = REPO / "evals/experience-real-v2/capsules/pi-b455975/source.tar"
TRUST = "packages/coding-agent/src/core/resource-loader.ts"
MIGRATION = "packages/coding-agent/src/migrations.ts"
TOOLS = "packages/agent/src/harness/runtime/drive/tools.ts"
GUARD = 'if (!cancelled && call.replay === "safe" && tool?.replay === "safe") {'
DECISION = "this.settingsManager.setProjectTrusted(projectTrusted);"


@dataclass(frozen=True)
class Fixture:
    episode: str
    stage: str
    target: str
    task: str
    before: str
    after: str


FIXTURES = (
    Fixture(
        "extension-trust",
        "learn",
        TRUST,
        "Project extensions leak into trust bootstrap. Bootstrap must force untrusted settings before reloading "
        "and resolving extensions, even if the previous state was trusted. User/global and CLI "
        "extensions remain available.",
        "this.settingsManager.setProjectTrusted(false);",
        "this.settingsManager.setProjectTrusted(true);",
    ),
    Fixture(
        "extension-trust",
        "transfer",
        TRUST,
        "An explicit trusted decision is ignored after bootstrap. Honor both true and false decisions, reload settings "
        "before final resource resolution, and keep project extensions excluded during bootstrap.",
        DECISION,
        "this.settingsManager.setProjectTrusted(false);",
    ),
    Fixture(
        "extension-trust",
        "correction",
        TRUST,
        "Correct the blanket refusal to consult the trust resolver. Policy explicitly allows project resources after "
        "a true decision, denies them after false, and requires the resolver to observe an untrusted bootstrap result. "
        "Call the resolver once and preserve its asynchronous ordering.",
        "const projectTrusted = await options.resolveProjectTrust({ extensionsResult: preTrustExtensions });",
        "const projectTrusted = false;",
    ),
    Fixture(
        "extension-trust",
        "retransfer",
        TRUST,
        "A fresh resource reload treats a denied trust decision as approval. Preserve phase separation: project "
        "resources are absent during bootstrap and after false, available after true; user/global and "
        "CLI remain available.",
        DECISION,
        "this.settingsManager.setProjectTrusted(true);",
    ),
    Fixture(
        "session-migration",
        "learn",
        MIGRATION,
        "Legacy oauth.json with a UTF-8 BOM no longer migrates. Preserve OAuth credentials, API-key fallback and "
        "OAuth precedence; malformed input must not be destroyed. Existing auth.json must remain untouched.",
        'JSON.parse(stripBom(readFileSync(oauthPath, "utf-8")))',
        'JSON.parse(readFileSync(oauthPath, "utf-8"))',
    ),
    Fixture(
        "session-migration",
        "transfer",
        MIGRATION,
        "Windows session cwd paths migrate to the wrong directory. Encode POSIX, drive-letter and UNC paths by "
        "removing one leading slash/backslash and replacing every slash, backslash and colon with '-'. Preserve "
        "session bytes, ignore invalid headers, never overwrite an existing destination, and keep repeated runs safe.",
        r'.replace(/[/\\:]/g, "-")',
        r'.replace(/[/:]/g, "-")',
    ),
    Fixture(
        "session-migration",
        "correction",
        MIGRATION,
        "Correct the migration collision policy: an existing destination always wins. Leave both its bytes and "
        "the colliding legacy source untouched; continue migrating unrelated files. Never overwrite or "
        "delete either copy.",
        "if (existsSync(newPath)) continue;",
        "// Existing destinations are incorrectly overwritten.",
    ),
    Fixture(
        "session-migration",
        "retransfer",
        MIGRATION,
        "A collision in a new legacy session batch prevents later files migrating. Skip only the colliding file, "
        "preserve both copies, and continue the batch. Repeated runs must be idempotent; malformed "
        "headers remain untouched.",
        "if (existsSync(newPath)) continue;",
        "if (existsSync(newPath)) return;",
    ),
    Fixture(
        "tool-recovery-order",
        "learn",
        TOOLS,
        "Interrupted tools replay if either safety declaration is safe. Replay requires BOTH persisted call policy "
        "and current tool declaration to be safe, and no cancellation. Otherwise publish an interrupted outcome with "
        "the durable checkpoint, without clearing it or invoking the tool.",
        GUARD,
        'if (!cancelled && (call.replay === "safe" || tool?.replay === "safe")) {',
    ),
    Fixture(
        "tool-recovery-order",
        "transfer",
        TOOLS,
        "Recovery ignores a changed or missing current tool declaration. Recheck it against persisted replay policy; "
        "only both-safe, non-cancelled calls replay. Missing tools must settle as interrupted rather "
        "than throw or execute.",
        GUARD,
        'if (!cancelled && call.replay === "safe") {',
    ),
    Fixture(
        "tool-recovery-order",
        "correction",
        TOOLS,
        "Correct a blanket never-replay rule. Verified safe/safe calls must replay once when not cancelled. Clear "
        "their old checkpoint before invocation, publish the resulting outcome after invocation completes, and retain "
        "the conditional restrictions for unsafe, missing and cancelled declarations.",
        GUARD,
        'if (false && !cancelled && call.replay === "safe" && tool?.replay === "safe") {',
    ),
    Fixture(
        "tool-recovery-order",
        "retransfer",
        TOOLS,
        "A newly interrupted batch replays even after cancellation. Cancellation must prevent checkpoint clearing "
        "and tool invocation even for safe/safe calls; publish interrupted evidence instead. Non-cancelled safe/safe "
        "calls must still replay once and settle after completion.",
        GUARD,
        'if (call.replay === "safe" && tool?.replay === "safe") {',
    ),
)


def render() -> dict[Path, str]:
    files: dict[Path, str] = {}
    public_loader = (REPO / "scripts/real_experience_contracts/subject.mjs").read_text(encoding="utf-8")
    with tarfile.open(CAPSULE) as archive:
        sources = {}
        for target in {fixture.target for fixture in FIXTURES}:
            member = archive.extractfile(target)
            if member is None:
                raise ValueError(f"missing capsule source: {target}")
            sources[target] = member.read().decode("utf-8")
    for fixture in FIXTURES:
        base = ROOT / fixture.episode / fixture.stage
        source = sources[fixture.target]
        if source.count(fixture.before) != 1:
            raise ValueError(f"mutation anchor must be unique: {fixture.episode}/{fixture.stage}")
        mutated = source.replace(fixture.before, fixture.after, 1)
        files[base / "mutation.patch"] = "".join(
            difflib.unified_diff(
                source.splitlines(keepends=True),
                mutated.splitlines(keepends=True),
                fromfile=f"a/{fixture.target}",
                tofile=f"b/{fixture.target}",
            )
        )
        task_id = f"{fixture.episode}/{fixture.stage}"
        files[base / "TASK.md"] = (
            f"# {task_id}\n\n{fixture.task}\n\n"
            f"Repair `{fixture.target}` with minimal changes. Add `.prale-eval/regression.mjs`, a standalone Node "
            "assertion script that exercises the repaired production code. It must exit zero when fixed and fail with "
            "an assertion on this stage's original fault. No dependencies or network are needed: Node 24 provides "
            "TypeScript stripping and VM modules. The read-only `.prale-eval/subject.mjs` helper loads the real source "
            "with explicit boundary fakes; inspect its exported functions for usage. Run "
            "`node --experimental-vm-modules .prale-eval/regression.mjs` from the workspace root. "
            "Do not replace assertions with printed success.\n\n"
            "Write `.prale-eval/result.json` with "
            f"`task_id` = `{task_id}`, `repository` = `earendil-works/pi`, `mode` = `repair`, "
            "and a `validation` object with `command` exactly "
            "`node --experimental-vm-modules .prale-eval/regression.mjs`, `status` = `passed`, and "
            "substantive `notes`. "
            "Hidden acceptance executes production behavior and replays your regression on isolated fixed and "
            "original-fault copies. A timeout, syntax/import error, or missing runtime is a failure, not proof that "
            "the regression detected the fault.\n\n"
            "Only modify the target source and add regression files under `.prale-eval/`. Do not modify TASK.md, "
            "subject.mjs, package locks, Git configuration, or harness files. The acceptance oracle is hidden.\n"
        )
        files[base / "fixture.json"] = (
            json.dumps(
                {
                    "oracle_version": 3,
                    "fixture_revision": 4,
                    "episode": fixture.episode,
                    "stage": fixture.stage,
                    "task_id": task_id,
                    "target": fixture.target,
                    "source_commit": "b45597504eeaba1f11a9920a1d1048c361ed4b8e",
                },
                indent=2,
                sort_keys=True,
            )
            + "\n"
        )
        files[base / "workspace/.prale-eval/subject.mjs"] = public_loader
        # The actual oracle remains external; resolve relative to this fixture, never agent cwd.
        files[base / "oracle.py"] = (
            '"""Version-3 executable behavior and mutation-sensitive regression acceptance."""\n'
            "import sys\nfrom pathlib import Path\n\n"
            "sys.path.insert(0, str(Path(__file__).resolve().parents[5] / 'scripts'))\n"
            "from real_experience_oracle import main  # noqa: E402\n\n"
            "raise SystemExit(main(Path(__file__).resolve().parent))\n"
        )
    return files


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    files = render()
    if args.check:
        return (
            0
            if all(path.is_file() and path.read_text(encoding="utf-8") == content for path, content in files.items())
            else 1
        )
    for path, content in files.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    print(f"wrote {len(files)} real-repository fixture files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
