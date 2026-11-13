/**
 * Regression for: legacy oauth.json with a UTF-8 BOM no longer migrates.
 *
 * Exercises the real production `migrateAuthToAuthJson` from
 * packages/coding-agent/src/migrations.ts (loaded through subject.mjs with the
 * real fs/path modules and only config.ts + utils/text.ts faked out).
 *
 * Run from the workspace root:
 *   node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMigrations } from "./subject.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BOM = "\uFEFF";
const sandbox = path.join(root, ".prale-eval", ".tmp");

mkdirSync(sandbox, { recursive: true });
const created = [];
const tempAgentDir = () => {
	const dir = mkdtempSync(path.join(sandbox, "agent-"));
	created.push(dir);
	return dir;
};

const readJson = (file) => JSON.parse(readFileSync(file, "utf-8"));
/** Production values come from another VM realm; normalize before deep comparison. */
const plain = (value) => JSON.parse(JSON.stringify(value));
const checks = [];

async function check(name, body) {
	const agentDir = tempAgentDir();
	await body(agentDir);
	checks.push(name);
	process.stdout.write(`ok - ${name}\n`);
}

try {
	// 1. The incident: a UTF-8 BOM must not stop legacy OAuth credentials from migrating.
	await check("BOM-prefixed oauth.json migrates OAuth credentials to auth.json", async (agentDir) => {
		const credential = { access: "access-token", refresh: "refresh-token", expires: 1_700_000_000_000 };
		const legacy = `${BOM}${JSON.stringify({ anthropic: credential }, null, 2)}`;
		writeFileSync(path.join(agentDir, "oauth.json"), legacy);

		const { migrateAuthToAuthJson } = await loadMigrations(root, agentDir);
		const providers = migrateAuthToAuthJson();

		assert.deepEqual(plain(providers), ["anthropic"], "BOM-prefixed oauth.json must report migrated providers");
		const authPath = path.join(agentDir, "auth.json");
		assert.ok(existsSync(authPath), "auth.json must be created from BOM-prefixed oauth.json");
		assert.deepEqual(readJson(authPath), { anthropic: { type: "oauth", ...credential } });
		assert.equal(statSync(authPath).mode & 0o777, 0o600, "auth.json must stay owner-only readable");
		assert.ok(!existsSync(path.join(agentDir, "oauth.json")), "migrated oauth.json must be renamed away");
		assert.equal(
			readFileSync(`${path.join(agentDir, "oauth.json")}.migrated`, "utf-8"),
			legacy,
			"renamed oauth.json.migrated must preserve the original file byte for byte",
		);
	});

	// 2. BOM-less oauth.json still migrates (no regression of the plain path).
	await check("plain oauth.json still migrates", async (agentDir) => {
		writeFileSync(path.join(agentDir, "oauth.json"), JSON.stringify({ openai: { access: "a", refresh: "r" } }));

		const { migrateAuthToAuthJson } = await loadMigrations(root, agentDir);
		assert.deepEqual(plain(migrateAuthToAuthJson()), ["openai"]);
		assert.deepEqual(readJson(path.join(agentDir, "auth.json")), {
			openai: { type: "oauth", access: "a", refresh: "r" },
		});
	});

	// 3. API-key fallback from a BOM-prefixed settings.json apiKeys block.
	await check("BOM-prefixed settings.json apiKeys migrate as api_key fallback", async (agentDir) => {
		writeFileSync(
			path.join(agentDir, "settings.json"),
			`${BOM}${JSON.stringify({ theme: "dark", apiKeys: { openai: "sk-openai" } }, null, 2)}`,
		);

		const { migrateAuthToAuthJson } = await loadMigrations(root, agentDir);
		assert.deepEqual(plain(migrateAuthToAuthJson()), ["openai"]);
		assert.deepEqual(readJson(path.join(agentDir, "auth.json")), {
			openai: { type: "api_key", key: "sk-openai" },
		});
		const settings = readJson(path.join(agentDir, "settings.json"));
		assert.equal(settings.apiKeys, undefined, "migrated apiKeys must be removed from settings.json");
		assert.equal(settings.theme, "dark", "unrelated settings must be preserved");
	});

	// 4. OAuth credentials take precedence over an apiKeys entry for the same provider.
	await check("OAuth credentials take precedence over settings apiKeys", async (agentDir) => {
		writeFileSync(
			path.join(agentDir, "oauth.json"),
			`${BOM}${JSON.stringify({ anthropic: { access: "oauth-access", refresh: "oauth-refresh" } })}`,
		);
		writeFileSync(
			path.join(agentDir, "settings.json"),
			JSON.stringify({ apiKeys: { anthropic: "sk-anthropic", openai: "sk-openai" } }),
		);

		const { migrateAuthToAuthJson } = await loadMigrations(root, agentDir);
		assert.deepEqual(plain(migrateAuthToAuthJson()), ["anthropic", "openai"]);
		assert.deepEqual(readJson(path.join(agentDir, "auth.json")), {
			anthropic: { type: "oauth", access: "oauth-access", refresh: "oauth-refresh" },
			openai: { type: "api_key", key: "sk-openai" },
		});
	});

	// 5. Malformed legacy input must not be destroyed and must not fabricate auth.json.
	await check("malformed oauth.json is left intact and produces no auth.json", async (agentDir) => {
		const malformed = '{"anthropic": {"access": "truncated"';
		const oauthPath = path.join(agentDir, "oauth.json");
		writeFileSync(oauthPath, `${BOM}${malformed}`);

		const { migrateAuthToAuthJson } = await loadMigrations(root, agentDir);
		assert.deepEqual(plain(migrateAuthToAuthJson()), []);
		assert.ok(!existsSync(path.join(agentDir, "auth.json")), "no auth.json may be written from malformed input");
		assert.equal(readFileSync(oauthPath, "utf-8"), `${BOM}${malformed}`, "malformed oauth.json must be preserved byte for byte");
		assert.ok(!existsSync(`${oauthPath}.migrated`), "malformed oauth.json must not be renamed");
	});

	// 6. An existing auth.json stays untouched and suppresses the migration.
	await check("existing auth.json is never overwritten", async (agentDir) => {
		const authPath = path.join(agentDir, "auth.json");
		const existing = '{"anthropic":{"type":"api_key","key":"existing"}}\n';
		writeFileSync(authPath, existing);
		const oauthPath = path.join(agentDir, "oauth.json");
		writeFileSync(oauthPath, `${BOM}${JSON.stringify({ openai: { access: "a", refresh: "r" } })}`);

		const { migrateAuthToAuthJson } = await loadMigrations(root, agentDir);
		assert.deepEqual(plain(migrateAuthToAuthJson()), []);
		assert.equal(readFileSync(authPath, "utf-8"), existing, "existing auth.json must remain untouched");
		assert.equal(
			readFileSync(oauthPath, "utf-8"),
			`${BOM}${JSON.stringify({ openai: { access: "a", refresh: "r" } })}`,
			"legacy oauth.json must be left in place when auth.json already exists",
		);
		assert.ok(!existsSync(`${oauthPath}.migrated`));
	});

	assert.ok(checks.length === 6, "all migration regression checks must run");
	process.stdout.write(`\n${checks.length} migration regression checks passed\n`);
} finally {
	for (const dir of created) rmSync(dir, { recursive: true, force: true });
	try {
		rmSync(sandbox, { recursive: true, force: true });
	} catch {
		// Leave the empty helper directory behind if it cannot be removed.
	}
}
