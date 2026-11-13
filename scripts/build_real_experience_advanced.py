"""Generate twelve multi-module repairs against the frozen real pi repository."""

from __future__ import annotations

import argparse
import difflib
import json
import tarfile
from dataclasses import dataclass
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
ROOT = Path("evals/experience-real-v2/advanced/fixtures")
CAPSULE = REPO / "evals/experience-real-v2/capsules/pi-b455975/source.tar"
COMMIT = "b45597504eeaba1f11a9920a1d1048c361ed4b8e"
CODING = "packages/coding-agent/src/"
AGENT = "packages/agent/src/harness/"
RESOURCE = CODING + "core/resource-loader.ts"
SETTINGS = CODING + "core/settings-manager.ts"
PROJECT = CODING + "core/project-trust.ts"
MIGRATION = CODING + "migrations.ts"
SESSION = CODING + "core/session-manager.ts"
TEXT = CODING + "utils/text.ts"
PATHS = CODING + "utils/paths.ts"
DRIVE = AGENT + "runtime/drive/tools.ts"
EXECUTION = AGENT + "execution/tools.ts"
GATE = AGENT + "execution/effect-gate.ts"
PLACEMENT = AGENT + "runtime/drive/tool-placement.ts"
MODULES = (RESOURCE, SETTINGS, PROJECT, MIGRATION, SESSION, TEXT, PATHS, DRIVE, EXECUTION, GATE, PLACEMENT)
GUARD = 'if (!cancelled && call.replay === "safe" && tool?.replay === "safe") {'
DECISION = "this.settingsManager.setProjectTrusted(projectTrusted);"


@dataclass(frozen=True)
class Fault:
    target: str
    before: str
    after: str


@dataclass(frozen=True)
class Fixture:
    episode: str
    stage: str
    title: str
    request: str
    faults: tuple[Fault, ...]

    @property
    def task_id(self) -> str:
        return f"advanced/{self.episode}/{self.stage}"


FIXTURES = (
    Fixture(
        "resource-consistency",
        "learn",
        "Untrusted startup leaks project configuration",
        "An already-trusted process starts a fresh project bootstrap and sees project resources before consent. "
        "An explicit false override is also lost. Restore the end-to-end boundary: bootstrap reads only global "
        "configuration, explicit overrides (including false) win without prompting, and trusted reload later "
        "admits project resources. Preserve global/CLI resources and nested settings inheritance.",
        (
            Fault(
                RESOURCE,
                "this.settingsManager.setProjectTrusted(false);",
                "this.settingsManager.setProjectTrusted(true);",
            ),
            Fault(SETTINGS, 'if (scope === "project" && !projectTrusted) {', "if (false) {"),
            Fault(PROJECT, "if (options.trustOverride !== undefined) {", "if (options.trustOverride) {"),
        ),
    ),
    Fixture(
        "resource-consistency",
        "transfer",
        "Remembered denial and configuration precedence disagree",
        "A stored denial unexpectedly falls through to an allow-by-default policy, while accepted reloads lose "
        "project configuration. Reconcile resolver, settings and resource assembly: a stored boolean is "
        "authoritative, project values override global values only while trusted, nested global defaults survive, "
        "and an approved decision must reach final resource resolution.",
        (
            Fault(PROJECT, "if (decision !== null) {", "if (decision) {"),
            Fault(
                SETTINGS,
                "return deepMergeObjects(base as Record<string, unknown>, "
                "overrides as Record<string, unknown>) as Settings;",
                "return deepMergeObjects(overrides as Record<string, unknown>, "
                "base as Record<string, unknown>) as Settings;",
            ),
            Fault(RESOURCE, DECISION, "this.settingsManager.setProjectTrusted(false);"),
        ),
    ),
    Fixture(
        "resource-consistency",
        "correction",
        "Session-only approval must not become permanent consent",
        "Policy clarification: a trusted decision may grant access for this session without persisting consent. "
        "The resolver must run exactly once after an untrusted bootstrap; changing trust must actually reload "
        "project settings. Persist an extension decision only when remember is explicitly true. Both approval "
        "and denial must work without weakening bootstrap or mutating global configuration.",
        (
            Fault(
                RESOURCE,
                "const projectTrusted = await options.resolveProjectTrust({ extensionsResult: preTrustExtensions });",
                "const projectTrusted = false;",
            ),
            Fault(SETTINGS, "if (this.projectTrusted === trusted) {", "if (this.projectTrusted !== trusted) {"),
            Fault(PROJECT, "if (result.remember === true) {", "if (result.remember !== undefined) {"),
        ),
    ),
    Fixture(
        "resource-consistency",
        "retransfer",
        "Revocation must clear cached resources and settings",
        "A headless reload with no stored decision and ask policy must deny access. After a previous approval, "
        "revoking trust must immediately discard project configuration and remove project extensions from the "
        "next resolved resource set. Preserve global and CLI resources; reload without a resolver must retain "
        "the existing trust state. Do not turn missing UI into implicit consent.",
        (
            Fault(
                PROJECT,
                "if (!options.projectTrustContext.hasUI) {\n\t\treturn false;",
                "if (!options.projectTrustContext.hasUI) {\n\t\treturn true;",
            ),
            Fault(SETTINGS, "this.projectSettings = {};", "this.projectSettings = this.projectSettings;"),
            Fault(RESOURCE, DECISION, "this.settingsManager.setProjectTrusted(true);"),
        ),
    ),
    Fixture(
        "session-integrity",
        "learn",
        "Legacy credentials lose encoding and provider precedence",
        "A legacy upgrade combines BOM-encoded OAuth and settings API keys. Credentials disappear or the "
        "fallback overwrites OAuth. Repair decoding and merge policy across the input utility and migration: "
        "remove only a leading BOM, preserve plain and interior-BOM text, prefer OAuth over same-provider API "
        "keys, retain unrelated settings, archive successful OAuth input and leave malformed data untouched. "
        "An existing auth.json must prevent all credential migration.",
        (
            Fault(TEXT, "return splitBom(content).text;", "return content;"),
            Fault(MIGRATION, 'if (!migrated[provider] && typeof key === "string") {', 'if (typeof key === "string") {'),
        ),
    ),
    Fixture(
        "session-integrity",
        "transfer",
        "Migrated sessions cannot be found by the normal reader",
        "Legacy migration writes sessions to a directory different from the session manager's canonical "
        "lookup. Restore a shared observable path contract for absolute POSIX cwd values containing slash, "
        "backslash and colon, including Windows-style path fragments inside an absolute POSIX path. This task "
        "does not emulate Windows path resolution or convert a raw Windows cwd on Linux. "
        "Verify migrated files through the real session "
        "reader, preserving Unicode, entry order and bytes. Malformed lines may be skipped; collisions must "
        "not overwrite data and repeated migration must be safe.",
        (
            Fault(MIGRATION, r'.replace(/[/\\:]/g, "-")', r'.replace(/[/:]/g, "-")'),
            Fault(SESSION, r'.replace(/[/\\:]/g, "-")', r'.replace(/[/\\]/g, "-")'),
        ),
    ),
    Fixture(
        "session-integrity",
        "correction",
        "Collision safety and invalid-header repair must agree",
        "Clarified data-safety policy: existing destination bytes always win, and a session reader must reject "
        "a header lacking a string ID before repairing a missing final newline. Preserve both sides of a "
        "collision, continue other migrations, reject invalid headers without rewriting their files, and "
        "still accept valid headers and repair valid unterminated final records.",
        (
            Fault(MIGRATION, "if (existsSync(newPath)) continue;", "// Regression: overwrite a colliding destination."),
            Fault(
                SESSION,
                'if (header.type !== "session" || typeof (header as { id?: unknown }).id !== "string") {',
                'if (header.type !== "session" && typeof (header as { id?: unknown }).id !== "string") {',
            ),
        ),
    ),
    Fixture(
        "session-integrity",
        "retransfer",
        "Resume a mixed legacy batch without dropping its tail",
        "A batch begins with a collision and ends with a valid session whose last JSONL record has no newline. "
        "The collision must not stop later migrations, and reading the resulting file must retain its final "
        "record exactly once before appending a newline. Verify ordered Unicode payloads, malformed-line "
        "skipping, idempotent re-read and unchanged colliding source/destination bytes.",
        (
            Fault(MIGRATION, "if (existsSync(newPath)) continue;", "if (existsSync(newPath)) return;"),
            Fault(SESSION, "if (finalEntry) entries.push(finalEntry);", "// Regression: discard final JSONL entry."),
        ),
    ),
    Fixture(
        "execution-lifecycle",
        "learn",
        "Recovery authorization must survive effect admission",
        "Recovery admits an unsafe interrupted operation and executes stale arguments. Repair the entire "
        "authorization-to-effect chain: both replay declarations must be safe, cancellation/closed gate must "
        "prevent admission, and the executor must use the cleared/persisted arguments rather than the original "
        "model arguments. Clear the old checkpoint before invocation and publish only after the effect and "
        "durable progress drain finish. Missing tools remain interrupted rather than executing.",
        (
            Fault(DRIVE, GUARD, 'if (!cancelled && (call.replay === "safe" || tool?.replay === "safe")) {'),
            Fault(EXECUTION, "\n\t\t\t\tcall.args,", "\n\t\t\t\tcall.toolCall.arguments,"),
            Fault(GATE, "\n\t\t\t\tcheck();", "\n\t\t\t\t// Regression: admission skips gate state."),
        ),
    ),
    Fixture(
        "execution-lifecycle",
        "transfer",
        "Live progress, durable progress and errors diverge",
        "A recovered tool emits live progress, an explicit checkpoint, then fails. Only checkpoint=true updates "
        "may be persisted; all admitted live updates still reach observers, a tool exception remains an error "
        "in the final message, and signaling an abort must reach the already-admitted tool's AbortSignal. "
        "No new effects may be admitted after beginAbort, and final publication must follow progress drain.",
        (
            Fault(
                DRIVE,
                "if (options?.checkpoint === true) progress.write(partial);",
                "if (options?.checkpoint !== false) progress.write(partial);",
            ),
            Fault(
                EXECUTION,
                "result: createErrorToolResult(error instanceof Error ? error.message : String(error)),"
                "\n\t\t\t\tisError: true,",
                "result: createErrorToolResult(error instanceof Error ? error.message : String(error)),"
                "\n\t\t\t\tisError: false,",
            ),
            Fault(
                GATE,
                "controller.abort(new AbortRequested(state.cancellation));",
                "// Regression: abort signal is never delivered.",
            ),
        ),
    ),
    Fixture(
        "execution-lifecycle",
        "correction",
        "Allow safe recovery without corrupting patched outcomes",
        "Policy clarification: non-cancelled safe/safe replay is allowed, and an after-tool hook may explicitly "
        "clear isError. Preserve unspecified result fields and usage while applying explicit false/empty "
        "patch values. If an aborting gate is closed with a terminal error, the terminal error becomes "
        "authoritative for future admissions; a pending cancellation must not override that closure.",
        (
            Fault(DRIVE, GUARD, 'if (false && !cancelled && call.replay === "safe" && tool?.replay === "safe") {'),
            Fault(
                EXECUTION,
                "isError: patch?.isError ?? executed.isError,",
                "isError: patch?.isError || executed.isError,",
            ),
            Fault(GATE, 'if (state.status === "closed") return;', 'if (state.status !== "open") return;'),
        ),
    ),
    Fixture(
        "execution-lifecycle",
        "retransfer",
        "Cancellation and completion must fence off late activity",
        "A cancelled recovery still executes, and a completed tool can emit new updates. Enforce lifecycle "
        "fences across scheduler, executor and gate: cancelled recoveries never clear/invoke; completion seals "
        "live and checkpoint callbacks; beginAbort cannot reopen a closed gate or replace its terminal error. "
        "Non-cancelled safe/safe recovery must still complete, preserve usage/details and publish once.",
        (
            Fault(DRIVE, GUARD, 'if (call.replay === "safe" && tool?.replay === "safe") {'),
            Fault(EXECUTION, "acceptingUpdates = false;", "acceptingUpdates = true;"),
            Fault(GATE, 'if (state.status !== "open") return;', 'if (state.status === "aborting") return;'),
        ),
    ),
)


def sources() -> dict[str, str]:
    with tarfile.open(CAPSULE) as archive:
        result = {}
        for target in MODULES:
            member = archive.extractfile(target)
            if member is None:
                raise ValueError(f"missing source: {target}")
            result[target] = member.read().decode("utf-8")
        return result


def render() -> dict[Path, str]:
    original = sources()
    files: dict[Path, str] = {}
    helper = (REPO / "scripts/real_experience_public_subject.mjs").read_text(encoding="utf-8")
    for fixture in FIXTURES:
        base = ROOT / fixture.episode / fixture.stage
        patches: list[str] = []
        targets = [fault.target for fault in fixture.faults]
        for fault in fixture.faults:
            source = original[fault.target]
            if source.count(fault.before) != 1:
                raise ValueError(f"anchor is not unique: {fixture.task_id}: {fault.target}: {fault.before!r}")
            patched = source.replace(fault.before, fault.after, 1)
            patches.extend(
                difflib.unified_diff(
                    source.splitlines(keepends=True),
                    patched.splitlines(keepends=True),
                    fromfile=f"a/{fault.target}",
                    tofile=f"b/{fault.target}",
                )
            )
        files[base / "mutation.patch"] = "".join(patches)
        metadata = {
            "oracle_version": 4,
            "fixture_revision": 5,
            "public_support_version": 1,
            "suite_id": "real-v2-advanced-v1",
            "source_commit": COMMIT,
            "task_id": fixture.task_id,
            "episode": fixture.episode,
            "stage": fixture.stage,
            "title": fixture.title,
            "targets": targets,
            "minimum_source_files": len(targets),
        }
        files[base / "fixture.json"] = json.dumps(metadata, indent=2, sort_keys=True) + "\n"
        files[base / "TASK.md"] = (
            f"# {fixture.title}\n\nTask ID: `{fixture.task_id}`\nRepository: `earendil-works/pi`\n\n"
            f"## Incident\n\n{fixture.request}\n\n"
            "Locate the faulty production code by exploring the repository and tracing the incident across "
            "producer/consumer boundaries. Preserve existing APIs and unrelated behavior.\n\n"
            "## Delivery and local validation\n\n"
            "Apply the necessary production repairs, and add an executable `.prale-eval/regression.mjs`. It must load "
            "the submitted production modules and assert observable behavior across module boundaries. The read-only "
            "`.prale-eval/subject.mjs` helper provides "
            "`createGraph(root, modules, bindings, builtinOverrides, trailers)` and "
            "`loadModule(root, relativePath, bindings, trailer)`. Discover paths and symbols yourself, select "
            "the real modules to link, and supply your own boundary fakes. No task-specific adapters are supplied. "
            "Node 24 is sufficient; no dependencies, network, credentials or deployment are needed.\n\n"
            "Run `node --experimental-vm-modules .prale-eval/regression.mjs` from the workspace root. Use uncaught "
            "`node:assert/strict` assertions. The same script must pass the repair and detect the original regression "
            "in every source file when that file alone is restored to its faulty baseline. A crash, import error "
            "or timeout does not count as a detected regression. Do not use real time, randomness or external services "
            "as correctness evidence; control asynchronous ordering with promises.\n\n"
            "Create local test inputs under `.prale-eval/` and clean them up so manual validation stays inside "
            "the workspace. The controller's hidden tests manage their own temporary directories.\n\n"
            "Write `.prale-eval/result.json` with `task_id` exactly "
            f"`{fixture.task_id}`, `repository` = `earendil-works/pi`, `mode` = `repair`, and `validation` containing "
            "`command` = `node --experimental-vm-modules .prale-eval/regression.mjs`, `status` = `passed`, "
            "and substantive `notes`. Explain the cross-module fix in `.prale-eval/repair.md`.\n\n"
            "Modify only production code needed for this incident and add tests under `.prale-eval/`. "
            "Do not modify TASK.md, "
            "subject.mjs, locks, Git configuration or harness files. Hidden oracles and mutation patches are not "
            "part of your workspace.\n"
        )
        files[base / "workspace/.prale-eval/subject.mjs"] = helper
        files[base / "oracle.py"] = (
            '"""External advanced multi-module oracle entry point."""\n'
            "import sys\nfrom pathlib import Path\n\n"
            "root = next(p for p in Path(__file__).resolve().parents "
            "if (p / 'scripts/real_experience_advanced_oracle.py').is_file())\n"
            "sys.path.insert(0, str(root / 'scripts'))\n"
            "from real_experience_advanced_oracle import main  # noqa: E402\n\n"
            "raise SystemExit(main(Path(__file__).resolve().parent))\n"
        )
    files[ROOT / ".gitattributes"] = (
        "# Unified diff context contains original tabs and blank lines.\n*.patch -whitespace\n"
    )
    files[ROOT.parent / "benchmark.json"] = (
        json.dumps(
            {
                "benchmark_id": "prale-experience-real-v2",
                "suite_id": "real-v2-advanced-v1",
                "fixture_revision": 5,
                "public_support_version": 1,
                "oracle_version": 4,
                "source_commit": COMMIT,
                "capsule": "../capsules/pi-b455975/capsule.json",
                "task_count": len(FIXTURES),
                "minimum_source_files_per_task": 2,
                "runtime": "Node 24, Python 3.12+; no npm/network needed",
                "stages": ["learn", "transfer", "correction", "retransfer"],
                "tasks": [
                    {
                        "id": f.task_id,
                        "episode": f.episode,
                        "stage": f.stage,
                        "title": f.title,
                        "targets": [fault.target for fault in f.faults],
                    }
                    for f in FIXTURES
                ],
            },
            indent=2,
            ensure_ascii=False,
        )
        + "\n"
    )
    files[ROOT.parent / "TASKSET.md"] = (
        "# Real-v2 advanced: twelve multi-module repairs\n\n"
        "Generated by `scripts/build_real_experience_advanced.py`. Each stage starts from a fresh frozen pi "
        "workspace with all listed faults applied. Targets link to each other's actual submitted source.\n\n"
        "| Task | Incident | Production files |\n|---|---|---|\n"
        + "".join(
            f"| {f.task_id} | {f.title} | " + ", ".join(f"`{fault.target}`" for fault in f.faults) + " |\n"
            for f in FIXTURES
        )
        + "\nAcceptance is deterministic: hidden cross-module contracts, a passing submitted regression, "
        "assertion failures for each independently restored source fault and the original combined incident. "
        "No LLM quality judge is used. Every repaired-file subset is checked by the corpus tests.\n"
    )
    return files


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    files = render()
    if args.check:
        return int(
            not all(path.is_file() and path.read_text(encoding="utf-8") == content for path, content in files.items())
        )
    for path, content in files.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    print(f"wrote {len(files)} advanced fixture files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
