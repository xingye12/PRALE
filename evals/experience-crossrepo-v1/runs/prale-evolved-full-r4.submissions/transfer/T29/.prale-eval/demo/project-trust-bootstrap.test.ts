/**
 * T29 demo: a fresh project extension is unavailable during the bootstrap pass and
 * becomes available only after an explicit trusted decision.
 *
 * This drives the real `DefaultResourceLoader`
 * (packages/coding-agent/src/core/resource-loader.ts):
 *
 *   1. `reload({ resolveProjectTrust })` first calls `loadProjectTrustExtensions()`,
 *      which forces `SettingsManager.setProjectTrusted(false)` for the bootstrap pass,
 *      so project-local extensions/packages stay out while user/global extensions load.
 *   2. The explicit `resolveProjectTrust` callback receives that bootstrap result.
 *      Only when it returns `true` does `reload()` set the project trusted and let
 *      `loadFinalExtensionSet()` add the project extension to the final set.
 *
 * Run from the repository root:
 *   npx vitest --run --config packages/coding-agent/vitest.config.ts \
 *     .prale-eval/demo/project-trust-bootstrap.test.ts
 *
 * The repository uses vitest; this file is a normal vitest suite so it exercises the
 * production loader rather than a re-implementation.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.ts";

interface Fixture {
	tempDir: string;
	agentDir: string;
	cwd: string;
	userExtensionPath: string;
	projectExtensionPath: string;
}

const cleanups: string[] = [];

function makeFixture(label: string): Fixture {
	const tempDir = join(tmpdir(), `pi-t29-demo-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	cleanups.push(tempDir);
	const agentDir = join(tempDir, "agent");
	const cwd = join(tempDir, "project");
	const userExtensionPath = join(agentDir, "extensions", "user.ts");
	const projectExtensionPath = join(cwd, ".pi", "extensions", "project.ts");

	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });

	// Fresh user/global extension: always eligible, no trust required.
	writeFileSync(
		userExtensionPath,
		`export default function (pi) {
	pi.registerCommand("user-only", { description: "user extension", handler() {} });
}
`,
	);

	// Fresh project extension fixture: command name is a unique sentinel for this demo.
	writeFileSync(
		projectExtensionPath,
		`export default function (pi) {
	pi.registerCommand("project-only", { description: "project extension", handler() {} });
}
`,
	);

	return { tempDir, agentDir, cwd, userExtensionPath, projectExtensionPath };
}

afterEach(() => {
	for (const dir of cleanups.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("T29 project extension trust gate", () => {
	it("keeps the project extension out of bootstrap and adds it only after an explicit trusted decision", async () => {
		const fx = makeFixture("trusted");
		const loader = new DefaultResourceLoader({ cwd: fx.cwd, agentDir: fx.agentDir });

		let bootstrapPaths: string[] = [];
		let finalPaths: string[] = [];
		const decisions: boolean[] = [];

		await loader.reload({
			resolveProjectTrust: async ({ extensionsResult }) => {
				// This is the untrusted bootstrap set produced by loadProjectTrustExtensions().
				bootstrapPaths = extensionsResult.extensions.map((extension) => extension.path);
				decisions.push(true);
				return true;
			},
		});

		finalPaths = loader.getExtensions().extensions.map((extension) => extension.path);

		// Bootstrap pass: user extension only, project extension deliberately absent.
		expect(bootstrapPaths).toContain(fx.userExtensionPath);
		expect(bootstrapPaths).not.toContain(fx.projectExtensionPath);

		// After the explicit trusted decision: the project extension is now available.
		expect(decisions).toEqual([true]);
		expect(finalPaths).toContain(fx.userExtensionPath);
		expect(finalPaths).toContain(fx.projectExtensionPath);

		const projectExtension = loader
			.getExtensions()
			.extensions.find((extension) => extension.path === fx.projectExtensionPath);
		expect(Array.from(projectExtension?.commands.keys() ?? [])).toContain("project-only");

		// eslint-disable-next-line no-console
		console.log(
			JSON.stringify(
				{
					operation: "resource-loader.reload.resolveProjectTrust",
					decision: "trusted",
					bootstrapExtensions: bootstrapPaths,
					finalExtensions: finalPaths,
					projectExtensionAvailableAfterDecision: finalPaths.includes(fx.projectExtensionPath),
				},
				null,
				2,
			),
		);
	});

	it("keeps the project extension unavailable when the explicit decision is not trusted", async () => {
		const fx = makeFixture("untrusted");
		const loader = new DefaultResourceLoader({ cwd: fx.cwd, agentDir: fx.agentDir });

		let bootstrapPaths: string[] = [];

		await loader.reload({
			resolveProjectTrust: async ({ extensionsResult }) => {
				bootstrapPaths = extensionsResult.extensions.map((extension) => extension.path);
				return false;
			},
		});

		const finalPaths = loader.getExtensions().extensions.map((extension) => extension.path);

		expect(bootstrapPaths).not.toContain(fx.projectExtensionPath);
		expect(finalPaths).toContain(fx.userExtensionPath);
		expect(finalPaths).not.toContain(fx.projectExtensionPath);
		expect(loader.getExtensions().extensions.some((extension) => extension.path === fx.projectExtensionPath)).toBe(
			false,
		);

		// eslint-disable-next-line no-console
		console.log(
			JSON.stringify(
				{
					operation: "resource-loader.reload.resolveProjectTrust",
					decision: "untrusted",
					bootstrapExtensions: bootstrapPaths,
					finalExtensions: finalPaths,
					projectExtensionAvailableAfterDecision: finalPaths.includes(fx.projectExtensionPath),
				},
				null,
				2,
			),
		);
	});
});
