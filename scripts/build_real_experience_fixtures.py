# ruff: noqa: E501
"""Build deterministic, agent-visible task fixtures for the frozen pi capsule.

The patch and oracle are written beside, not inside, the workspace copied to an
agent.  Fixture content is intentionally generated from this source so a task
revision is reviewable and ``--check`` can protect against accidental drift.
"""

import argparse
from dataclasses import dataclass
from pathlib import Path

ROOT = Path("evals/experience-real-v2/fixtures")


@dataclass(frozen=True)
class Fixture:
    episode: str
    stage: str
    target: str
    task: str
    patch: str
    required: str


FIXTURES = (
    Fixture(
        "extension-trust", "learn", "packages/coding-agent/src/core/resource-loader.ts",
        "A security regression lets project-local extensions enter the trust bootstrap. Repair the boundary and add a focused regression test.",
        "--- a/packages/coding-agent/src/core/resource-loader.ts\n+++ b/packages/coding-agent/src/core/resource-loader.ts\n@@ -435,7 +435,7 @@ export class DefaultResourceLoader {\n \tasync loadProjectTrustExtensions(): Promise<LoadExtensionsResult> {\n \t\t// Force untrusted project settings for the bootstrap pass. This keeps project-local\n \t\t// extensions/packages out while still loading user/global and temporary CLI extensions.\n-\t\tthis.settingsManager.setProjectTrusted(false);\n+\t\tthis.settingsManager.setProjectTrusted(true);\n \t\tawait this.settingsManager.reload();\n \t\treturn this.loadCurrentExtensionSet({ includeInlineFactories: true });\n \t}\n",
        "this.settingsManager.setProjectTrusted(false);",
    ),
    Fixture(
        "extension-trust", "transfer", "packages/coding-agent/src/core/resource-loader.ts",
        "A fresh trust-transition failure affects a different project-local resource. Repair it without weakening the untrusted bootstrap boundary.",
        "--- a/packages/coding-agent/src/core/resource-loader.ts\n+++ b/packages/coding-agent/src/core/resource-loader.ts\n@@ -451,7 +451,7 @@ export class DefaultResourceLoader {\n \t\tif (options?.resolveProjectTrust) {\n \t\t\tpreTrustExtensions = await this.loadProjectTrustExtensions();\n \t\t\tconst projectTrusted = await options.resolveProjectTrust({ extensionsResult: preTrustExtensions });\n-\t\t\tthis.settingsManager.setProjectTrusted(projectTrusted);\n+\t\t\tthis.settingsManager.setProjectTrusted(false);\n \t\t}\n",
        "this.settingsManager.setProjectTrusted(projectTrusted);",
    ),
    Fixture("extension-trust", "correction", "packages/coding-agent/src/core/resource-loader.ts", "Verified policy now permits an explicit trusted decision after bootstrap. Correct any blanket prohibition and preserve the bootstrap guard.", "", "this.settingsManager.setProjectTrusted(projectTrusted);"),
    Fixture("extension-trust", "retransfer", "packages/coding-agent/src/core/resource-loader.ts", "Apply the corrected trust rule to this new resource-loading regression and add a focused test.", "", "this.settingsManager.setProjectTrusted(projectTrusted);"),
    Fixture(
        "session-migration", "learn", "packages/coding-agent/src/migrations.ts",
        "Legacy auth data with a UTF-8 BOM no longer migrates. Restore compatibility and add a focused regression test.",
        "--- a/packages/coding-agent/src/migrations.ts\n+++ b/packages/coding-agent/src/migrations.ts\n@@ -33,7 +33,7 @@ export function migrateAuthToAuthJson(): string[] {\n \t// Migrate oauth.json\n \tif (existsSync(oauthPath)) {\n \t\ttry {\n-\t\t\tconst oauth = JSON.parse(stripBom(readFileSync(oauthPath, \"utf-8\")));\n+\t\t\tconst oauth = JSON.parse(readFileSync(oauthPath, \"utf-8\"));\n \t\t\tfor (const [provider, cred] of Object.entries(oauth)) {\n",
        "JSON.parse(stripBom(readFileSync(oauthPath, \"utf-8\")))",
    ),
    Fixture(
        "session-migration", "transfer", "packages/coding-agent/src/migrations.ts",
        "A fresh migration failure only appears for a Windows session cwd. Preserve cross-platform safe-path encoding and add a regression test.",
        "--- a/packages/coding-agent/src/migrations.ts\n+++ b/packages/coding-agent/src/migrations.ts\n@@ -111,7 +111,7 @@ export function migrateSessionsFromAgentRoot(): void {\n \t\t\tconst cwd: string = header.cwd;\n \n \t\t\t// Compute the correct session directory (same encoding as session-manager.ts)\n-\t\t\tconst safePath = `--${cwd.replace(/^[/\\\\]/, \"\").replace(/[/\\\\:]/g, \"-\")}--`;\n+\t\t\tconst safePath = `--${cwd.replace(/^[/\\\\]/, \"\").replace(/[/:]/g, \"-\")}--`;\n \t\t\tconst correctDir = join(agentDir, \"sessions\", safePath);\n",
        "replace(/[/\\\\:]/g, \"-\")",
    ),
    Fixture("session-migration", "correction", "packages/coding-agent/src/migrations.ts", "A verified collision policy supersedes the old assumption. Update the migration behavior and demonstrate it with a focused test.", "", "if (existsSync(newPath)) continue;"),
    Fixture("session-migration", "retransfer", "packages/coding-agent/src/migrations.ts", "Apply the corrected migration rule to another legacy session fixture.", "", "if (existsSync(newPath)) continue;"),
    Fixture(
        "tool-recovery-order", "learn", "packages/agent/src/harness/runtime/drive/tools.ts",
        "Interrupted tools are being replayed when the durable call or current declaration is unsafe. Repair the recovery guard and add a focused test.",
        "--- a/packages/agent/src/harness/runtime/drive/tools.ts\n+++ b/packages/agent/src/harness/runtime/drive/tools.ts\n@@ -524,7 +524,7 @@ export async function recoverPendingTool(\n-\tif (!cancelled && call.replay === \"safe\" && tool?.replay === \"safe\") {\n+\tif (!cancelled && (call.replay === \"safe\" || tool?.replay === \"safe\")) {\n",
        "call.replay === \"safe\" && tool?.replay === \"safe\"",
    ),
    Fixture("tool-recovery-order", "transfer", "packages/agent/src/harness/runtime/drive/tools.ts", "A separate recovered tool batch has the same safety boundary under a different failure path. Repair it and add a focused test.", "", "call.replay === \"safe\" && tool?.replay === \"safe\""),
    Fixture("tool-recovery-order", "correction", "packages/agent/src/harness/runtime/drive/tools.ts", "Verified metadata marks one operation safe to replay. Replace the old blanket never-replay rule with the conditional durable policy.", "", "call.replay === \"safe\" && tool?.replay === \"safe\""),
    Fixture("tool-recovery-order", "retransfer", "packages/agent/src/harness/runtime/drive/tools.ts", "Apply the corrected conditional replay policy to a new interrupted batch.", "", "call.replay === \"safe\" && tool?.replay === \"safe\""),
)

_TOOL_RECOVERY_PATCH = """--- a/packages/agent/src/harness/runtime/drive/tools.ts
+++ b/packages/agent/src/harness/runtime/drive/tools.ts
@@ -524,7 +524,7 @@
 ): Promise<ToolCallTask> {
 \tconst toolCall = toolCallFor(sources, call);
 \tconst tool = toolsByName.get(toolCall.name);
-\tif (!cancelled && call.replay === "safe" && tool?.replay === "safe") {
+\tif (!cancelled && (call.replay === "safe" || tool?.replay === "safe")) {
 \t\tconst args = await clearReplayCheckpoint(lane, drive, run.batch, call, toolCall);
 \t\tconst cleared: ClearedToolCall<TContext> = { toolCall, tool, args };
 \t\treturn {
"""


def render() -> dict[Path, str]:
    files: dict[Path, str] = {}
    for fixture in FIXTURES:
        base = ROOT / fixture.episode / fixture.stage
        files[base / "TASK.md"] = f"# {fixture.episode}/{fixture.stage}\n\n{fixture.task}\n\nOnly modify the repository workspace. The acceptance oracle is hidden.\n"
        mutation = (
            fixture.patch.replace("@@ -451,7 +451,7 @@", "@@ -451,5 +451,5 @@")
            .replace("@@ -33,7 +33,7 @@", "@@ -33,5 +33,5 @@")
            .replace("@@ -111,7 +111,7 @@", "@@ -111,5 +111,5 @@")
            .replace("@@ -524,7 +524,7 @@", "@@ -527 +527 @@")
            .replace("@@ -527 +527 @@ export async function recoverPendingTool(", "@@ -527,1 +527,1 @@")
        )
        files[base / "mutation.patch"] = _TOOL_RECOVERY_PATCH if fixture.episode == "tool-recovery-order" and fixture.stage == "learn" else mutation
        files[base / "oracle.py"] = (
            "import sys\nfrom pathlib import Path\n\n"
            "workspace = Path(sys.argv[1])\n"
            f"target = workspace / {fixture.target!r}\n"
            f"required = {fixture.required!r}\n"
            "if required not in target.read_text(encoding='utf-8'):\n"
            "    raise SystemExit(f'missing required behavior: {required}')\n"
            "print('acceptance passed')\n"
        )
    return files


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    files = render()
    if args.check:
        return 0 if all(path.is_file() and path.read_text(encoding="utf-8") == content for path, content in files.items()) else 1
    for path, content in files.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    print(f"wrote {len(files)} real-repository fixture files")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
