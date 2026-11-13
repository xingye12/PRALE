/**
 * Regression for session-migration/learn
 * "Legacy oauth.json with a UTF-8 BOM no longer migrates."
 *
 * Exercises the real `migrateAuthToAuthJson()` from
 * packages/coding-agent/src/migrations.ts (loaded through ./subject.mjs with a
 * caller-owned temporary agentDir and only the agent-dir / BOM boundary faked).
 *
 * Covered behaviour:
 *  1. oauth.json written with a leading UTF-8 BOM still migrates into auth.json.
 *  2. settings.json apiKeys remain the fallback, and oauth credentials keep
 *     precedence over an apiKeys entry for the same provider.
 *  3. A malformed oauth.json is not destroyed (no rename, no truncation).
 *  4. An existing auth.json stays untouched and short-circuits the migration.
 *  5. A BOM-less oauth.json keeps migrating (no regression for the legacy shape).
 *
 * Run from the workspace root:
 *   node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { loadMigrations } from "./subject.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const TMP_PARENT = path.join(ROOT, ".prale-eval");
const BOM = "\uFEFF";
const createdDirs = [];

function makeAgentDir(label) {
	fs.mkdirSync(TMP_PARENT, { recursive: true });
	const dir = fs.mkdtempSync(path.join(TMP_PARENT, `.tmp-${label}-`));
	createdDirs.push(dir);
	return dir;
}

function writeFile(agentDir, name, content) {
	const filePath = path.join(agentDir, name);
	fs.writeFileSync(filePath, content, "utf-8");
	return filePath;
}

function readText(filePath, label) {
	assert.ok(fs.existsSync(filePath), `${label}: expected ${path.basename(filePath)} to exist`);
	return fs.readFileSync(filePath, "utf-8");
}

function readJson(filePath, label) {
	return JSON.parse(readText(filePath, label));
}

/** Run the real migration against a fresh temporary agentDir. */
async function migrate(label, files) {
	const agentDir = makeAgentDir(label);
	for (const [name, content] of Object.entries(files)) writeFile(agentDir, name, content);
	const migrations = await loadMigrations(ROOT, agentDir);
	const migratedProviders = migrations.migrateAuthToAuthJson();
	return { agentDir, migratedProviders };
}

async function testBomOauthMigrates() {
	const oauth = {
		anthropic: { access: "bom-anthropic-access", refresh: "bom-anthropic-refresh", expires: 1_900_000_000_000 },
		"openai-codex": { access: "bom-codex-access", refresh: "bom-codex-refresh", expires: 1_900_000_000_001 },
	};
	const legacyContent = `${BOM}${JSON.stringify(oauth, null, 2)}\n`;
	const { agentDir, migratedProviders } = await migrate("bom-oauth", { "oauth.json": legacyContent });

	assert.deepEqual(
		[...migratedProviders].sort(),
		["anthropic", "openai-codex"],
		"legacy oauth.json with a UTF-8 BOM must report the migrated providers",
	);

	const authPath = path.join(agentDir, "auth.json");
	const auth = readJson(authPath, "BOM oauth migration must write auth.json");
	assert.deepEqual(
		auth,
		{
			anthropic: { type: "oauth", ...oauth.anthropic },
			"openai-codex": { type: "oauth", ...oauth["openai-codex"] },
		},
		"BOM oauth.json credentials must be preserved verbatim as type \"oauth\" entries",
	);

	assert.equal(
		readText(path.join(agentDir, "oauth.json.migrated"), "BOM oauth.json must be archived"),
		legacyContent,
		"the archived legacy oauth.json must keep its original bytes",
	);
	assert.ok(!fs.existsSync(path.join(agentDir, "oauth.json")), "oauth.json must be moved aside after migrating");
}

async function testOauthPrecedenceAndApiKeyFallback() {
	const settings = { theme: "dark", apiKeys: { anthropic: "settings-anthropic-key", openai: "sk-settings-openai" } };
	const oauth = { anthropic: { access: "oauth-access", refresh: "oauth-refresh", expires: 1_900_000_000_002 } };
	const { agentDir, migratedProviders } = await migrate("precedence", {
		"oauth.json": `${BOM}${JSON.stringify(oauth, null, 2)}\n`,
		"settings.json": JSON.stringify(settings, null, 2),
	});

	assert.deepEqual(
		[...migratedProviders],
		["anthropic", "openai"],
		"oauth providers are reported first, then apiKeys-only providers",
	);

	const auth = readJson(path.join(agentDir, "auth.json"), "precedence migration must write auth.json");
	assert.deepEqual(
		auth.anthropic,
		{ type: "oauth", ...oauth.anthropic },
		"oauth credentials must take precedence over a settings.json apiKeys entry for the same provider",
	);
	assert.deepEqual(
		auth.openai,
		{ type: "api_key", key: "sk-settings-openai" },
		"settings.json apiKeys must still be used as the fallback for providers without oauth credentials",
	);

	const migratedSettings = readJson(path.join(agentDir, "settings.json"), "settings.json must stay readable");
	assert.equal(migratedSettings.apiKeys, undefined, "settings.json apiKeys must be removed once migrated");
	assert.equal(migratedSettings.theme, "dark", "unrelated settings must be preserved");
}

async function testMalformedOauthIsNotDestroyed() {
	const malformed = '{ "anthropic": { "access": "truncated" ';
	const { agentDir, migratedProviders } = await migrate("malformed", { "oauth.json": malformed });

	assert.deepEqual([...migratedProviders], [], "a malformed oauth.json must not report migrated providers");
	assert.equal(
		readText(path.join(agentDir, "oauth.json"), "malformed oauth.json must be preserved"),
		malformed,
		"a malformed oauth.json must not be rewritten or truncated",
	);
	assert.ok(
		!fs.existsSync(path.join(agentDir, "oauth.json.migrated")),
		"a malformed oauth.json must not be renamed away",
	);
	assert.ok(
		!fs.existsSync(path.join(agentDir, "auth.json")),
		"a malformed oauth.json must not produce a partial auth.json",
	);
}

async function testExistingAuthJsonIsUntouched() {
	const existingAuth = `${JSON.stringify({ anthropic: { type: "api_key", key: "already-migrated" } }, null, 2)}\n`;
	const legacyOauth = `${BOM}${JSON.stringify({ openai: { access: "a", refresh: "r", expires: 1 } }, null, 2)}\n`;
	const { agentDir, migratedProviders } = await migrate("existing-auth", {
		"auth.json": existingAuth,
		"oauth.json": legacyOauth,
	});

	assert.deepEqual([...migratedProviders], [], "an existing auth.json must short-circuit the auth migration");
	assert.equal(
		readText(path.join(agentDir, "auth.json"), "existing auth.json must be preserved"),
		existingAuth,
		"an existing auth.json must remain byte-for-byte untouched",
	);
	assert.equal(
		readText(path.join(agentDir, "oauth.json"), "legacy oauth.json must be left in place"),
		legacyOauth,
		"oauth.json must not be consumed while an auth.json already exists",
	);
}

async function testOauthWithoutBomStillMigrates() {
	const oauth = { google: { access: "plain-access", refresh: "plain-refresh", expires: 1_900_000_000_003 } };
	const { agentDir, migratedProviders } = await migrate("plain-oauth", {
		"oauth.json": JSON.stringify(oauth, null, 2),
	});

	assert.deepEqual([...migratedProviders], ["google"], "a BOM-less oauth.json must keep migrating");
	assert.deepEqual(
		readJson(path.join(agentDir, "auth.json"), "plain oauth.json must migrate"),
		{ google: { type: "oauth", ...oauth.google } },
		"BOM-less oauth credentials must be preserved verbatim",
	);
}

try {
	await testBomOauthMigrates();
	await testOauthPrecedenceAndApiKeyFallback();
	await testMalformedOauthIsNotDestroyed();
	await testExistingAuthJsonIsUntouched();
	await testOauthWithoutBomStillMigrates();
} finally {
	for (const dir of createdDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

console.log("regression: oauth.json BOM migration checks passed");
