/**
 * Regression for: legacy oauth.json written with a UTF-8 BOM must still migrate
 * into auth.json (OAuth credentials preserved, apiKeys only as fallback, OAuth
 * winning on provider collisions), while malformed input and an existing
 * auth.json are left untouched.
 *
 * Exercises the real production `migrateAuthToAuthJson` from
 * packages/coding-agent/src/migrations.ts through .prale-eval/subject.mjs.
 * Run from the workspace root:
 *   node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMigrations } from "./subject.mjs";

const evalDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(evalDir);
const scratch = path.join(evalDir, ".tmp-regression");

function freshDir(name, files = {}) {
	const dir = path.join(scratch, name);
	mkdirSync(dir, { recursive: true });
	for (const [file, content] of Object.entries(files)) {
		writeFileSync(path.join(dir, file), content);
	}
	return dir;
}

function readJson(file) {
	const text = readFileSync(file, "utf-8");
	return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
}

function assertBomFixture(file) {
	const raw = readFileSync(file, "utf-8");
	assert.equal(
		raw.charCodeAt(0),
		0xfeff,
		`fixture ${path.basename(file)} must start with a UTF-8 BOM to reproduce the incident`,
	);
	return raw;
}

const oauthFixture = {
	anthropic: { access: "anthropic-access-token", refresh: "anthropic-refresh-token", expires: 1_900_000_000_000 },
	"custom-provider": { access: "custom-access-token", refresh: "custom-refresh-token", expires: 1_800_000_000_000 },
};

let checks = 0;
async function check(name, fn) {
	await fn();
	checks++;
	console.log(`ok ${checks} - ${name}`);
}

rmSync(scratch, { recursive: true, force: true });

try {
	await check("legacy oauth.json with a UTF-8 BOM migrates instead of being skipped", async () => {
		const agentDir = freshDir("bom-oauth", {
			"oauth.json": `\uFEFF${JSON.stringify(oauthFixture, null, 2)}`,
		});
		const oauthPath = path.join(agentDir, "oauth.json");
		const authPath = path.join(agentDir, "auth.json");
		assertBomFixture(oauthPath);

		const migrations = await loadMigrations(root, agentDir);
		const providers = migrations.migrateAuthToAuthJson();

		assert.deepEqual(
			[...providers].sort(),
			["anthropic", "custom-provider"],
			"BOM-prefixed oauth.json providers must be reported as migrated",
		);
		assert.ok(existsSync(authPath), "auth.json must be created from the BOM-prefixed oauth.json");

		const auth = readJson(authPath);
		assert.equal(auth.anthropic?.type, "oauth", "migrated credential must be an OAuth credential");
		assert.equal(auth.anthropic?.access, "anthropic-access-token", "OAuth access token must be preserved");
		assert.equal(auth.anthropic?.refresh, "anthropic-refresh-token", "OAuth refresh token must be preserved");
		assert.equal(auth.anthropic?.expires, 1_900_000_000_000, "OAuth expiry must be preserved");
		assert.equal(auth["custom-provider"]?.type, "oauth");
		assert.equal(auth["custom-provider"]?.access, "custom-access-token");

		assert.ok(!existsSync(oauthPath), "successfully migrated oauth.json must be moved aside");
		assert.ok(existsSync(`${oauthPath}.migrated`), "migrated oauth.json must be kept as oauth.json.migrated");
		assert.deepEqual(
			readJson(`${oauthPath}.migrated`),
			oauthFixture,
			"oauth.json.migrated must retain the original credentials",
		);
	});

	await check("apiKeys are only a fallback and OAuth wins on provider collisions", async () => {
		const agentDir = freshDir("precedence", {
			"oauth.json": `\uFEFF${JSON.stringify({ anthropic: oauthFixture.anthropic }, null, 2)}`,
			"settings.json": JSON.stringify(
				{ theme: "dark", apiKeys: { anthropic: "sk-shadowed-api-key", openai: "sk-openai-api-key" } },
				null,
				2,
			),
		});
		const oauthPath = path.join(agentDir, "oauth.json");
		assertBomFixture(oauthPath);

		const migrations = await loadMigrations(root, agentDir);
		const providers = migrations.migrateAuthToAuthJson();

		assert.deepEqual(
			[...providers].sort(),
			["anthropic", "openai"],
			"both the OAuth provider and the apiKeys-only provider must be migrated",
		);

		const auth = readJson(path.join(agentDir, "auth.json"));
		assert.equal(auth.anthropic?.type, "oauth", "existing OAuth credentials must take precedence over apiKeys");
		assert.equal(auth.anthropic?.access, "anthropic-access-token");
		assert.equal(auth.anthropic?.key, undefined, "the shadowed apiKey must not replace the OAuth credential");
		assert.deepEqual(auth.openai, { type: "api_key", key: "sk-openai-api-key" }, "apiKeys fallback must migrate");

		const settings = readJson(path.join(agentDir, "settings.json"));
		assert.equal(settings.apiKeys, undefined, "migrated apiKeys must be removed from settings.json");
		assert.equal(settings.theme, "dark", "unrelated settings must survive the apiKeys migration");
		assert.ok(!existsSync(oauthPath), "migrated oauth.json must be moved aside");
	});

	await check("malformed oauth.json is never destroyed and apiKeys still fall back", async () => {
		const malformed = `\uFEFF{"anthropic": {"access": "anthropic-access-token",`;
		const agentDir = freshDir("malformed", {
			"oauth.json": malformed,
			"settings.json": JSON.stringify({ apiKeys: { openai: "sk-openai-api-key" } }, null, 2),
		});
		const oauthPath = path.join(agentDir, "oauth.json");
		assertBomFixture(oauthPath);

		const migrations = await loadMigrations(root, agentDir);
		const providers = migrations.migrateAuthToAuthJson();

		assert.deepEqual([...providers], ["openai"], "only the apiKeys fallback may migrate from malformed oauth.json");
		assert.ok(existsSync(oauthPath), "malformed oauth.json must be preserved");
		assert.equal(readFileSync(oauthPath, "utf-8"), malformed, "malformed oauth.json must be byte-identical");
		assert.ok(!existsSync(`${oauthPath}.migrated`), "malformed oauth.json must not be renamed as migrated");

		const auth = readJson(path.join(agentDir, "auth.json"));
		assert.equal(auth.anthropic, undefined, "no credential may be invented from malformed oauth.json");
		assert.deepEqual(auth.openai, { type: "api_key", key: "sk-openai-api-key" });
	});

	await check("an existing auth.json is left untouched and blocks the migration", async () => {
		const authContent = `\uFEFF${JSON.stringify({ anthropic: { type: "oauth", access: "existing-access-token" } }, null, 2)}\n`;
		const settingsContent = JSON.stringify({ apiKeys: { openai: "sk-openai-api-key" } }, null, 2);
		const agentDir = freshDir("existing-auth", {
			"auth.json": authContent,
			"oauth.json": `\uFEFF${JSON.stringify(oauthFixture, null, 2)}`,
			"settings.json": settingsContent,
		});
		const oauthPath = path.join(agentDir, "oauth.json");
		const authPath = path.join(agentDir, "auth.json");

		const migrations = await loadMigrations(root, agentDir);
		const providers = migrations.migrateAuthToAuthJson();

		assert.deepEqual([...providers], [], "nothing may be migrated when auth.json already exists");
		assert.equal(readFileSync(authPath, "utf-8"), authContent, "existing auth.json must be byte-identical");
		assert.ok(existsSync(oauthPath), "oauth.json must not be moved when auth.json already exists");
		assert.ok(!existsSync(`${oauthPath}.migrated`));
		assert.equal(readFileSync(path.join(agentDir, "settings.json"), "utf-8"), settingsContent);
	});
} finally {
	rmSync(scratch, { recursive: true, force: true });
}

console.log(`all ${checks} auth migration regression checks passed`);
