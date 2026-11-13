/**
 * Regression coverage for the legacy auth migration (migrations.ts).
 *
 * Incident: a legacy `oauth.json` written with a UTF-8 BOM silently failed to
 * migrate, so OAuth credentials were dropped and settings.json API keys took
 * precedence instead. Invariants that must hold:
 *   - BOM-prefixed oauth.json migrates into auth.json as `type: "oauth"`.
 *   - settings.json `apiKeys` remain the fallback for providers without OAuth.
 *   - OAuth credentials win over an apiKey for the same provider.
 *   - malformed legacy files are never renamed/removed.
 *   - an existing auth.json is left completely untouched.
 *
 * Runs the real production module through .prale-eval/subject.mjs with faked
 * filesystem boundaries (agent dir) and a stubbed chalk/keybindings/config.
 *
 * Usage: node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createGraph } from "./subject.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = "packages/coding-agent/src/migrations.ts";
const TEXT_UTILS = "packages/coding-agent/src/utils/text.ts";

/** Minimal chalk stand-in: every style is an identity function (chainable). */
const styler = new Proxy(function (value) {
	return String(value ?? "");
}, {
	get: () => styler,
	apply: (_target, _thisArg, args) => String(args[0] ?? ""),
});

const BOM = "\uFEFF";

/** Local re-implementation used only as a boundary binding fallback. */
function boundaryStripBom(content) {
	return typeof content === "string" && content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
}

/**
 * Load the real production module. `state.agentDir` is the faked agent
 * directory read by the production `getAgentDir()` boundary.
 */
async function loadMigrations(state) {
	const bindings = {
		default: styler,
		CONFIG_DIR_NAME: ".pi",
		getAgentDir: () => state.agentDir,
		getBinDir: () => path.join(state.agentDir, "bin"),
		migrateKeybindingsConfig: (config) => ({ config, migrated: false }),
		// Fallbacks in case the module resolves stripBom/splitBom outside the graph.
		stripBom: boundaryStripBom,
		splitBom: (content) => (boundaryStripBom(content) === content
			? { bom: "", text: content }
			: { bom: BOM, text: boundaryStripBom(content) }),
	};
	const graph = createGraph(ROOT, [MIGRATIONS, TEXT_UTILS], bindings);
	const ns = await graph.module(MIGRATIONS);
	assert.equal(
		typeof ns.migrateAuthToAuthJson,
		"function",
		"production module packages/coding-agent/src/migrations.ts must export migrateAuthToAuthJson()",
	);
	assert.equal(typeof ns.runMigrations, "function", "production module must export runMigrations()");
	return ns;
}

const tmpRoot = fs.mkdtempSync(path.join(ROOT, ".prale-eval", ".regression-tmp-"));
let dirSeq = 0;
function makeAgentDir() {
	const dir = path.join(tmpRoot, `agent-${++dirSeq}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function writeFile(dir, name, content) {
	fs.writeFileSync(path.join(dir, name), content, "utf-8");
}
function readFile(dir, name) {
	return fs.readFileSync(path.join(dir, name), "utf-8");
}
function exists(dir, name) {
	return fs.existsSync(path.join(dir, name));
}

const tests = [];
function test(name, fn) {
	tests.push({ name, fn });
}

// ---------------------------------------------------------------------------
// 1. The incident itself: legacy oauth.json written with a UTF-8 BOM.
// ---------------------------------------------------------------------------
test("migrates a BOM-prefixed legacy oauth.json into auth.json with OAuth precedence", async () => {
	const dir = makeAgentDir();
	const oauthRaw = `${BOM}${JSON.stringify(
		{ anthropic: { access: "oauth-access", refresh: "oauth-refresh", expires: 1700000000000 } },
		null,
		2,
	)}`;
	writeFile(dir, "oauth.json", oauthRaw);
	writeFile(
		dir,
		"settings.json",
		JSON.stringify({ theme: "dark", apiKeys: { anthropic: "sk-must-lose", openai: "sk-openai" } }, null, 2),
	);

	const mod = await loadMigrations({ agentDir: dir });
	const providers = [...mod.migrateAuthToAuthJson()];

	assert.ok(exists(dir, "auth.json"), "auth.json must be created by the migration");
	const auth = JSON.parse(readFile(dir, "auth.json"));
	assert.deepEqual(
		auth.anthropic,
		{ type: "oauth", access: "oauth-access", refresh: "oauth-refresh", expires: 1700000000000 },
		"OAuth credentials from the BOM-prefixed oauth.json must be preserved verbatim",
	);
	assert.deepEqual(
		providers,
		["anthropic", "openai"],
		"BOM-prefixed oauth.json must be migrated and settings apiKeys must still fall in behind it",
	);
	assert.deepEqual(
		auth.openai,
		{ type: "api_key", key: "sk-openai" },
		"providers without legacy OAuth credentials must still fall back to settings.json apiKeys",
	);

	assert.equal(
		exists(dir, "oauth.json"),
		false,
		"a successfully migrated oauth.json must be moved aside",
	);
	assert.equal(
		readFile(dir, "oauth.json.migrated"),
		oauthRaw,
		"the migrated oauth.json backup must keep its original bytes",
	);

	const settings = JSON.parse(readFile(dir, "settings.json"));
	assert.deepEqual(settings, { theme: "dark" }, "migrated apiKeys must be removed while keeping other settings");

	// Re-running the migration must be a no-op and must not rewrite auth.json.
	const authBytes = readFile(dir, "auth.json");
	const secondRun = [...mod.migrateAuthToAuthJson()];
	assert.deepEqual(secondRun, [], "migration must not report providers again once auth.json exists");
	assert.equal(readFile(dir, "auth.json"), authBytes, "an existing auth.json must remain untouched");
});

// ---------------------------------------------------------------------------
// 2. API-key fallback without any legacy oauth.json.
// ---------------------------------------------------------------------------
test("migrates settings.json apiKeys when no legacy oauth.json exists", async () => {
	const dir = makeAgentDir();
	writeFile(dir, "settings.json", JSON.stringify({ apiKeys: { openai: "sk-fallback" } }));

	const mod = await loadMigrations({ agentDir: dir });
	const providers = [...mod.migrateAuthToAuthJson()];

	assert.deepEqual(providers, ["openai"], "settings.json apiKeys must migrate when oauth.json is absent");
	const auth = JSON.parse(readFile(dir, "auth.json"));
	assert.deepEqual(auth, { openai: { type: "api_key", key: "sk-fallback" } });
});

test("migrates apiKeys from a BOM-prefixed settings.json", async () => {
	const dir = makeAgentDir();
	writeFile(dir, "settings.json", `${BOM}${JSON.stringify({ apiKeys: { groq: "sk-bom-settings" } })}`);

	const mod = await loadMigrations({ agentDir: dir });
	const providers = [...mod.migrateAuthToAuthJson()];

	assert.deepEqual(providers, ["groq"], "a BOM-prefixed settings.json must still contribute its apiKeys");
	const auth = JSON.parse(readFile(dir, "auth.json"));
	assert.deepEqual(auth, { groq: { type: "api_key", key: "sk-bom-settings" } });
});

test("OAuth entries win over apiKey entries for the same provider", async () => {
	const dir = makeAgentDir();
	writeFile(dir, "oauth.json", JSON.stringify({ anthropic: { access: "a", refresh: "r", expires: 1 } }));
	writeFile(dir, "settings.json", JSON.stringify({ apiKeys: { anthropic: "sk-loses" } }));

	const mod = await loadMigrations({ agentDir: dir });
	const providers = [...mod.migrateAuthToAuthJson()];

	assert.deepEqual(providers, ["anthropic"], "a provider must be migrated exactly once, with OAuth precedence");
	const auth = JSON.parse(readFile(dir, "auth.json"));
	assert.deepEqual(auth, { anthropic: { type: "oauth", access: "a", refresh: "r", expires: 1 } });
});

// ---------------------------------------------------------------------------
// 3. Malformed legacy input must never be destroyed.
// ---------------------------------------------------------------------------
test("leaves a malformed BOM-prefixed oauth.json in place", async () => {
	const dir = makeAgentDir();
	const malformed = `${BOM}{"anthropic": {"access": "trunc`;
	writeFile(dir, "oauth.json", malformed);

	const mod = await loadMigrations({ agentDir: dir });
	const providers = [...mod.migrateAuthToAuthJson()];

	assert.deepEqual(providers, [], "a malformed oauth.json must not produce migrated providers");
	assert.equal(exists(dir, "oauth.json"), true, "a malformed oauth.json must not be removed or renamed");
	assert.equal(readFile(dir, "oauth.json"), malformed, "a malformed oauth.json must keep its original bytes");
	assert.equal(exists(dir, "oauth.json.migrated"), false, "a malformed oauth.json must not be moved aside");
	assert.equal(exists(dir, "auth.json"), false, "a malformed oauth.json alone must not create auth.json");
});

test("does not destroy a malformed oauth.json while still migrating apiKeys", async () => {
	const dir = makeAgentDir();
	const malformed = `${BOM}{"openai": `;
	writeFile(dir, "oauth.json", malformed);
	writeFile(dir, "settings.json", JSON.stringify({ apiKeys: { groq: "sk-groq" } }));

	const mod = await loadMigrations({ agentDir: dir });
	const providers = [...mod.migrateAuthToAuthJson()];

	assert.deepEqual(providers, ["groq"], "settings.json apiKeys must still migrate when oauth.json is malformed");
	assert.equal(readFile(dir, "oauth.json"), malformed, "a malformed oauth.json must be preserved byte for byte");
	assert.equal(exists(dir, "oauth.json.migrated"), false, "a malformed oauth.json must not be moved aside");
	const auth = JSON.parse(readFile(dir, "auth.json"));
	assert.deepEqual(auth, { groq: { type: "api_key", key: "sk-groq" } });
});

// ---------------------------------------------------------------------------
// 4. An existing auth.json blocks the migration entirely.
// ---------------------------------------------------------------------------
test("never modifies an existing auth.json", async () => {
	const dir = makeAgentDir();
	const existingAuth = `${JSON.stringify({ openai: { type: "api_key", key: "keep-me" } }, null, 2)}\n`;
	const oauthRaw = `${BOM}${JSON.stringify({ anthropic: { access: "a", refresh: "r", expires: 9 } })}`;
	writeFile(dir, "auth.json", existingAuth);
	writeFile(dir, "oauth.json", oauthRaw);
	writeFile(dir, "settings.json", JSON.stringify({ apiKeys: { groq: "sk-groq" } }, null, 2));

	const mod = await loadMigrations({ agentDir: dir });
	const providers = [...mod.migrateAuthToAuthJson()];

	assert.deepEqual(providers, [], "migration must not report providers when auth.json already exists");
	assert.equal(readFile(dir, "auth.json"), existingAuth, "an existing auth.json must remain byte-for-byte untouched");
	assert.equal(readFile(dir, "oauth.json"), oauthRaw, "legacy oauth.json must not be consumed when auth.json exists");
	assert.equal(exists(dir, "oauth.json.migrated"), false);
	assert.deepEqual(
		JSON.parse(readFile(dir, "settings.json")),
		{ apiKeys: { groq: "sk-groq" } },
		"settings.json must not be rewritten when auth.json already exists",
	);
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------
let failures = 0;
try {
	for (const { name, fn } of tests) {
		try {
			await fn();
			console.log(`ok - ${name}`);
		} catch (error) {
			failures += 1;
			console.error(`not ok - ${name}`);
			console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
		}
	}
} finally {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
}

if (failures > 0) {
	console.error(`\n${failures} of ${tests.length} regression test(s) failed`);
	process.exitCode = 1;
} else {
	console.log(`\nall ${tests.length} regression test(s) passed`);
}
