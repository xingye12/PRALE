#!/usr/bin/env node
/**
 * Regression coverage for the legacy credential migration incident.
 *
 * The script links the real production modules through `subject.mjs`
 * (`createSessionPipeline` -> real migrations.ts + real utils/text.ts) and
 * drives them against real files created inside `.prale-eval/.tmp/`.
 * Assertions are uncaught `node:assert/strict` failures so that restoring
 * either faulty source file (text.ts or migrations.ts) fails this script.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { createSessionPipeline } from "./subject.mjs";

const BOM = "\uFEFF";
const root = path.resolve(import.meta.dirname, "..");
const scratchRoot = path.join(import.meta.dirname, ".tmp");
const scratchDirs = [];

/** Create a throwaway agent directory containing the given legacy files. */
function makeAgentDir(label, files) {
	mkdirSync(scratchRoot, { recursive: true });
	const dir = mkdtempSync(path.join(scratchRoot, `${label}-`));
	const agentDir = path.join(dir, "agent");
	mkdirSync(agentDir, { recursive: true });
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(path.join(agentDir, name), content, "utf-8");
	}
	scratchDirs.push(dir);
	return agentDir;
}

function readJson(file) {
	return JSON.parse(readFileSync(file, "utf-8"));
}

/** Values returned from the vm-linked modules live in another realm, so clone them. */
function plain(value) {
	return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function cleanup() {
	for (const dir of scratchDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
	try {
		// Only succeeds when the scratch directory is empty: other runs may own entries.
		rmdirSync(scratchRoot);
	} catch {
		// Keep untouched when a concurrent run still holds fixtures.
	}
}

process.on("exit", cleanup);

async function withPipeline(files, label, fn) {
	const agentDir = makeAgentDir(label, files);
	const pipeline = await createSessionPipeline(root, agentDir);
	try {
		await fn({ ...pipeline, agentDir });
	} finally {
		// Fixtures never outlive the scenario, even when an assertion fails.
		rmSync(path.dirname(agentDir), { recursive: true, force: true });
		scratchDirs.splice(scratchDirs.indexOf(path.dirname(agentDir)), 1);
	}
}

const results = [];
async function scenario(name, fn) {
	await fn();
	results.push(name);
}

// ---------------------------------------------------------------------------
// 1. Input utility: decoding removes only a leading BOM.
// ---------------------------------------------------------------------------
await scenario("text.stripBom removes only a leading BOM", async () => {
	await withPipeline({}, "text", async ({ text }) => {
		// Leading BOM is dropped.
		assert.equal(text.stripBom(`${BOM}oauth`), "oauth");
		assert.equal(text.stripBom(`${BOM}{"a":1}`), '{"a":1}');
		// Plain text is preserved byte for byte.
		assert.equal(text.stripBom("plain-text"), "plain-text");
		assert.equal(text.stripBom(""), "");
		// Interior and trailing BOMs are content, not encoding markers.
		assert.equal(text.stripBom(`in${BOM}terior`), `in${BOM}terior`);
		assert.equal(text.stripBom(`trailing${BOM}`), `trailing${BOM}`);
		// Only a single leading BOM is removed.
		assert.equal(text.stripBom(`${BOM}${BOM}twice`), `${BOM}twice`);
		// splitBom stays consistent with stripBom.
		assert.deepEqual(plain(text.splitBom(`${BOM}body`)), { bom: BOM, text: "body" });
		assert.deepEqual(plain(text.splitBom(`mid${BOM}dle`)), { bom: "", text: `mid${BOM}dle` });
		for (const sample of [`${BOM}x`, "x", `a${BOM}b`, `${BOM}${BOM}c`, ""]) {
			assert.equal(text.stripBom(sample), text.splitBom(sample).text);
		}
	});
});

// ---------------------------------------------------------------------------
// 2. Migration: BOM-encoded oauth.json + settings.json apiKeys, OAuth wins.
// ---------------------------------------------------------------------------
const oauthContent = `${BOM}${JSON.stringify({
	anthropic: { access: "oauth-access-anthropic", refresh: "oauth-refresh-anthropic", expires: 1_700_000_000_000 },
	shared: { access: "oauth-access-shared", refresh: "oauth-refresh-shared", expires: 1_700_000_000_001 },
})}`;
const settingsWithoutApiKeys = {
	theme: `dark${BOM}mode`, // interior BOM stays part of the setting value
	defaultModel: "claude-sonnet-4",
	nested: { keep: true, list: ["a", "b"] },
};
const settingsContent = `${BOM}${JSON.stringify({
	...settingsWithoutApiKeys,
	apiKeys: { shared: "sk-shared-loses", openai: "sk-openai-wins", numeric: 42 },
})}`;

await scenario("BOM-encoded legacy files migrate with OAuth precedence", async () => {
	await withPipeline({ "oauth.json": oauthContent, "settings.json": settingsContent }, "bom", async ({ agentDir, migration }) => {
		const providers = plain(migration.migrateAuthToAuthJson());

		const authPath = path.join(agentDir, "auth.json");
		assert.ok(existsSync(authPath), "auth.json must be created from BOM-encoded legacy files");
		const auth = readJson(authPath);

		// OAuth credentials were decoded despite the BOM.
		assert.equal(auth.anthropic.type, "oauth");
		assert.equal(auth.anthropic.access, "oauth-access-anthropic");
		assert.equal(auth.anthropic.refresh, "oauth-refresh-anthropic");
		assert.equal(auth.anthropic.expires, 1_700_000_000_000);
		// OAuth wins over the same-provider API key from settings.json.
		assert.equal(auth.shared.type, "oauth");
		assert.equal(auth.shared.access, "oauth-access-shared");
		assert.equal(auth.shared.refresh, "oauth-refresh-shared");
		assert.equal(auth.shared.expires, 1_700_000_000_001);
		// API keys without an OAuth credential still migrate; non-strings do not.
		assert.equal(auth.openai.type, "api_key");
		assert.equal(auth.openai.key, "sk-openai-wins");
		assert.equal(auth.numeric, undefined);
		assert.deepEqual(Object.keys(auth).sort(), ["anthropic", "openai", "shared"]);
		assert.deepEqual([...providers].sort(), ["anthropic", "openai", "shared"]);
		assert.equal(new Set(providers).size, providers.length, "each provider is reported once");

		// Unrelated settings survive, the interior BOM survives, apiKeys is gone.
		const settings = readJson(path.join(agentDir, "settings.json"));
		assert.deepEqual(settings, settingsWithoutApiKeys);
		assert.equal(settings.theme, `dark${BOM}mode`);
		assert.equal(readFileSync(path.join(agentDir, "settings.json"), "utf-8").startsWith(BOM), false);

		// Successfully consumed OAuth input is archived with its original bytes.
		assert.equal(existsSync(path.join(agentDir, "oauth.json")), false);
		assert.equal(readFileSync(path.join(agentDir, "oauth.json.migrated"), "utf-8"), oauthContent);
	});
});

await scenario("plain legacy files migrate identically", async () => {
	await withPipeline(
		{ "oauth.json": JSON.stringify({ anthropic: { access: "a", refresh: "r", expires: 1 } }), "settings.json": settingsContent.slice(1) },
		"plain",
		async ({ agentDir, migration }) => {
			const providers = migration.migrateAuthToAuthJson();
			const auth = readJson(path.join(agentDir, "auth.json"));
			assert.deepEqual(auth.anthropic, { type: "oauth", access: "a", refresh: "r", expires: 1 });
			assert.deepEqual(auth.shared, { type: "api_key", key: "sk-shared-loses" });
			assert.equal(auth.openai.type, "api_key");
		assert.equal(auth.openai.key, "sk-openai-wins");
			assert.deepEqual([...providers].sort(), ["anthropic", "openai", "shared"]);
			assert.deepEqual(readJson(path.join(agentDir, "settings.json")), settingsWithoutApiKeys);
		},
	);
});

// ---------------------------------------------------------------------------
// 3. Malformed legacy input is left untouched and never archived.
// ---------------------------------------------------------------------------
await scenario("malformed oauth.json is left untouched", async () => {
	const malformed = `${BOM}{"anthropic": {"access": `;
	await withPipeline({ "oauth.json": malformed, "settings.json": settingsContent }, "malformed", async ({ agentDir, migration }) => {
		const providers = plain(migration.migrateAuthToAuthJson());
		assert.equal(readFileSync(path.join(agentDir, "oauth.json"), "utf-8"), malformed);
		assert.equal(existsSync(path.join(agentDir, "oauth.json.migrated")), false);

		const auth = readJson(path.join(agentDir, "auth.json"));
		assert.deepEqual(Object.keys(auth).sort(), ["openai", "shared"]);
		assert.equal(auth.shared.type, "api_key");
		assert.equal(auth.shared.key, "sk-shared-loses");
		assert.deepEqual([...providers].sort(), ["openai", "shared"]);
		assert.deepEqual(readJson(path.join(agentDir, "settings.json")), settingsWithoutApiKeys);
	});
});

// ---------------------------------------------------------------------------
// 4. An existing auth.json prevents every credential migration.
// ---------------------------------------------------------------------------
await scenario("existing auth.json blocks all credential migration", async () => {
	const existingAuth = JSON.stringify({ anthropic: { type: "api_key", key: "existing-key" } });
	await withPipeline(
		{ "auth.json": existingAuth, "oauth.json": oauthContent, "settings.json": settingsContent },
		"existing",
		async ({ agentDir, migration }) => {
			const providers = plain(migration.migrateAuthToAuthJson());
			assert.deepEqual(providers, []);
			assert.equal(readFileSync(path.join(agentDir, "auth.json"), "utf-8"), existingAuth);
			assert.equal(readFileSync(path.join(agentDir, "oauth.json"), "utf-8"), oauthContent);
			assert.equal(existsSync(path.join(agentDir, "oauth.json.migrated")), false);
			assert.equal(readFileSync(path.join(agentDir, "settings.json"), "utf-8"), settingsContent);
		},
	);
});

// ---------------------------------------------------------------------------
// 5. Nothing to migrate: no legacy files at all.
// ---------------------------------------------------------------------------
await scenario("no legacy files produce no auth.json", async () => {
	await withPipeline({}, "empty", async ({ agentDir, migration }) => {
		assert.deepEqual(plain(migration.migrateAuthToAuthJson()), []);
		assert.equal(existsSync(path.join(agentDir, "auth.json")), false);
	});
});

cleanup();
console.log(`regression.mjs passed ${results.length} scenarios:\n- ${results.join("\n- ")}`);
