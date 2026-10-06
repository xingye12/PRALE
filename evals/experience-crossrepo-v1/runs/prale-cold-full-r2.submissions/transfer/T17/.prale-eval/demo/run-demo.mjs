// Demo: a fresh project extension is unavailable during bootstrap and becomes
// available only after an explicit trusted decision.
//
// Runs the real packages/coding-agent source (DefaultResourceLoader) against a
// throwaway fixture project. Offline npm stubs are installed by register.mjs.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const demoDir = new URL(".", import.meta.url).pathname;
const repoRoot = new URL("../../", new URL(".", import.meta.url)).pathname;
const fixtureRoot = join(demoDir, ".tmp", `fixture-${process.pid}`);

const results = [];
const check = (label, condition, detail) => {
	results.push({ label, ok: condition, detail });
	console.log(`${condition ? "PASS" : "FAIL"} ${label}${detail ? ` — ${detail}` : ""}`);
};

const { DefaultResourceLoader } = await import(
	new URL("../../packages/coding-agent/src/core/resource-loader.ts", new URL(".", import.meta.url)).href
);

const USER_EXTENSION = `export default function (pi) {
	pi.registerCommand("user-extension", { description: "user extension", handler: async () => {} });
}
`;
const PROJECT_EXTENSION = `export default function (pi) {
	pi.registerCommand("fresh-project-extension", { description: "fresh project extension", handler: async () => {} });
}
`;

function makeFixture(name) {
	const root = join(fixtureRoot, name);
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
	writeFileSync(join(agentDir, "extensions", "user-extension.ts"), USER_EXTENSION);
	writeFileSync(join(cwd, ".pi", "extensions", "fresh-project-extension.ts"), PROJECT_EXTENSION);
	return { cwd, agentDir, projectExtensionPath: join(cwd, ".pi", "extensions", "fresh-project-extension.ts") };
}

const paths = (result) => result.extensions.map((extension) => extension.path);

rmSync(fixtureRoot, { recursive: true, force: true });
try {
	// ---------------------------------------------------------------- fixture
	const fixture = makeFixture("trusted");
	console.log(`fixture project: ${fixture.cwd}`);
	console.log(`fixture extension: ${fixture.projectExtensionPath}`);

	// ------------------------------------------------- bootstrap (pre-trust)
	const loader = new DefaultResourceLoader({ cwd: fixture.cwd, agentDir: fixture.agentDir });
	const bootstrap = await loader.loadProjectTrustExtensions();
	const bootstrapPaths = paths(bootstrap);

	check(
		"bootstrap keeps project extensions out",
		!bootstrapPaths.includes(fixture.projectExtensionPath),
		`bootstrap extensions: ${JSON.stringify(bootstrapPaths)}`,
	);
	check(
		"bootstrap still loads user extensions",
		bootstrapPaths.includes(join(fixture.agentDir, "extensions", "user-extension.ts")),
		`bootstrap extensions: ${JSON.stringify(bootstrapPaths)}`,
	);

	// ------------------------------------------- explicit trusted decision
	let observedDuringBootstrap;
	const reloadLoader = new DefaultResourceLoader({ cwd: fixture.cwd, agentDir: fixture.agentDir });
	await reloadLoader.reload({
		resolveProjectTrust: async ({ extensionsResult }) => {
			observedDuringBootstrap = paths(extensionsResult);
			return true;
		},
	});
	const afterTrust = paths(reloadLoader.getExtensions());

	check(
		"trust callback observes the project extension as unavailable",
		!observedDuringBootstrap.includes(fixture.projectExtensionPath),
		`callback saw: ${JSON.stringify(observedDuringBootstrap)}`,
	);
	check(
		"explicit trusted decision makes the project extension available",
		afterTrust.includes(fixture.projectExtensionPath),
		`after trust: ${JSON.stringify(afterTrust)}`,
	);
	check(
		"trusted pass keeps the user extension too",
		afterTrust.includes(join(fixture.agentDir, "extensions", "user-extension.ts")),
		`after trust: ${JSON.stringify(afterTrust)}`,
	);

	// ------------------------------------- negative control: explicit denial
	const deniedFixture = makeFixture("denied");
	const deniedLoader = new DefaultResourceLoader({ cwd: deniedFixture.cwd, agentDir: deniedFixture.agentDir });
	await deniedLoader.reload({ resolveProjectTrust: async () => false });
	const afterDenial = paths(deniedLoader.getExtensions());
	check(
		"explicit untrusted decision keeps the project extension unavailable",
		!afterDenial.includes(deniedFixture.projectExtensionPath),
		`after denial: ${JSON.stringify(afterDenial)}`,
	);
	check(
		"explicit untrusted decision still loads user extensions",
		afterDenial.includes(join(deniedFixture.agentDir, "extensions", "user-extension.ts")),
		`after denial: ${JSON.stringify(afterDenial)}`,
	);
} finally {
	rmSync(fixtureRoot, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exitCode = failed.length === 0 ? 0 : 1;
