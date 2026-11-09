/**
 * Regression for legacy oauth.json migration (UTF-8 BOM).
 *
 * Exercises the real `migrateAuthToAuthJson` from
 * packages/coding-agent/src/migrations.ts through the read-only
 * .prale-eval/subject.mjs loader (real fs/path, caller-owned agentDir).
 *
 * Fails with an assertion when a BOM-prefixed oauth.json is silently skipped,
 * and additionally pins the invariants around it: OAuth credentials survive,
 * API keys still act as a fallback, OAuth wins over API keys for the same
 * provider, unparseable oauth.json is never renamed/destroyed, and an
 * existing auth.json is left completely untouched.
 *
 * Run from the workspace root:
 *   node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadMigrations } from "./subject.mjs";

const root = path.resolve(import.meta.dirname, "..");
const scratchRoot = path.join(root, ".prale-eval", ".regression-tmp");
const BOM = "\uFEFF";

let counter = 0;

/** Run `fn` against a fresh agentDir, loading a fresh copy of the real module. */
async function withAgentDir(fn) {
	const agentDir = path.join(scratchRoot, `case-${process.pid}-${counter++}`);
	mkdirSync(agentDir, { recursive: true });
	const api = await loadMigrations(root, agentDir);
	await fn(api, agentDir);
}

const read = (file) => readFileSync(file, "utf8");
const write = (file, content) => writeFileSync(file, content, "utf8");
const authPathOf = (agentDir) => path.join(agentDir, "auth.json");
const oauthPathOf = (agentDir) => path.join(agentDir, "oauth.json");
const settingsPathOf = (agentDir) => path.join(agentDir, "settings.json");

mkdirSync(scratchRoot, { recursive: true });

try {
	// ---------------------------------------------------------------------
	// 1. BOM-prefixed oauth.json must migrate (this stage's original fault).
	// ---------------------------------------------------------------------
	await withAgentDir(async (api, agentDir) => {
		const oauthPath = oauthPathOf(agentDir);
		const settingsPath = settingsPathOf(agentDir);
		const authPath = authPathOf(agentDir);

		const oauthContent = `${BOM}${JSON.stringify(
			{
				anthropic: { access: "oat-access", refresh: "oat-refresh", expires: 1893456000000 },
				shared: { access: "oauth-shared", refresh: "oauth-refresh", expires: 42 },
			},
			null,
			2,
		)}`;
		write(oauthPath, oauthContent);
		write(
			settingsPath,
			JSON.stringify({ theme: "dark", apiKeys: { openai: "sk-openai", shared: "sk-loses", numericKey: 7 } }),
		);

		const providers = [...api.migrateAuthToAuthJson()];

		assert.deepStrictEqual(
			providers.sort(),
			["anthropic", "openai", "shared"],
			"BOM-prefixed oauth.json must migrate its OAuth providers alongside settings.json API-key fallbacks",
		);
		assert.ok(
			existsSync(authPath),
			"auth.json must be created when a BOM-prefixed oauth.json is the only credential source",
		);
		assert.deepStrictEqual(
			JSON.parse(read(authPath)),
			{
				anthropic: { type: "oauth", access: "oat-access", refresh: "oat-refresh", expires: 1893456000000 },
				shared: { type: "oauth", access: "oauth-shared", refresh: "oauth-refresh", expires: 42 },
				openai: { type: "api_key", key: "sk-openai" },
			},
			"OAuth credentials must be preserved verbatim with type=oauth and must take precedence over apiKeys",
		);
		assert.ok(!existsSync(oauthPath), "migrated oauth.json must be moved aside");
		assert.equal(
			read(`${oauthPath}.migrated`),
			oauthContent,
			"the migrated oauth.json backup must keep the original bytes (BOM included)",
		);
		const settings = JSON.parse(read(settingsPath));
		assert.deepStrictEqual(settings, { theme: "dark" }, "apiKeys must be removed from settings.json after migration");
		if (process.platform !== "win32") {
			assert.equal(statSync(authPath).mode & 0o777, 0o600, "auth.json credentials must be written 0600");
		}
	});

	// ---------------------------------------------------------------------
	// 2. Unparseable oauth.json (even with a BOM) must not be destroyed.
	// ---------------------------------------------------------------------
	await withAgentDir(async (api, agentDir) => {
		const oauthPath = oauthPathOf(agentDir);
		const authPath = authPathOf(agentDir);
		const brokenOauth = `${BOM}{"anthropic": {"access": "oat-access",`;
		write(oauthPath, brokenOauth);
		write(settingsPathOf(agentDir), JSON.stringify({ apiKeys: { openai: "sk-openai" } }));

		const providers = [...api.migrateAuthToAuthJson()];

		assert.deepStrictEqual(
			providers,
			["openai"],
			"a malformed oauth.json must be skipped without blocking the apiKeys fallback",
		);
		assert.ok(existsSync(oauthPath), "a malformed oauth.json must be left in place, not renamed");
		assert.ok(!existsSync(`${oauthPath}.migrated`), "a malformed oauth.json must not be recorded as migrated");
		assert.equal(read(oauthPath), brokenOauth, "a malformed oauth.json must keep its exact original bytes");
		assert.deepStrictEqual(
			JSON.parse(read(authPath)),
			{ openai: { type: "api_key", key: "sk-openai" } },
			"only the API-key fallback may be migrated when oauth.json is malformed",
		);
	});

	// ---------------------------------------------------------------------
	// 3. Malformed oauth.json alone must not create auth.json or throw.
	// ---------------------------------------------------------------------
	await withAgentDir(async (api, agentDir) => {
		const oauthPath = oauthPathOf(agentDir);
		const brokenOauth = `${BOM}not json at all`;
		write(oauthPath, brokenOauth);

		const providers = [...api.migrateAuthToAuthJson()];

		assert.deepStrictEqual(providers, [], "no provider may be reported when oauth.json cannot be parsed");
		assert.ok(!existsSync(authPathOf(agentDir)), "no auth.json may be written when there is nothing to migrate");
		assert.equal(read(oauthPath), brokenOauth, "the malformed oauth.json must survive untouched");
	});

	// ---------------------------------------------------------------------
	// 4. An existing auth.json must remain untouched.
	// ---------------------------------------------------------------------
	await withAgentDir(async (api, agentDir) => {
		const authPath = authPathOf(agentDir);
		const oauthPath = oauthPathOf(agentDir);
		const settingsPath = settingsPathOf(agentDir);
		const existingAuth = '{\n  "anthropic": {\n    "type": "api_key",\n    "key": "keep-me"\n  }\n}\n';
		const oauthContent = `${BOM}${JSON.stringify({ anthropic: { access: "oat-access", refresh: "oat-refresh" } })}`;
		const settingsContent = JSON.stringify({ apiKeys: { openai: "sk-openai" } });
		write(authPath, existingAuth);
		write(oauthPath, oauthContent);
		write(settingsPath, settingsContent);

		const providers = [...api.migrateAuthToAuthJson()];

		assert.deepStrictEqual(providers, [], "migration must be a no-op when auth.json already exists");
		assert.equal(read(authPath), existingAuth, "an existing auth.json must remain byte-for-byte untouched");
		assert.equal(read(oauthPath), oauthContent, "the legacy oauth.json must not be renamed when auth.json exists");
		assert.ok(!existsSync(`${oauthPath}.migrated`), "no oauth.json migration backup may be created");
		assert.equal(read(settingsPath), settingsContent, "settings.json must not be rewritten when auth.json exists");
	});

	// ---------------------------------------------------------------------
	// 5. Plain (no BOM) oauth.json migration keeps working.
	// ---------------------------------------------------------------------
	await withAgentDir(async (api, agentDir) => {
		write(
			oauthPathOf(agentDir),
			JSON.stringify({ anthropic: { access: "plain-access", refresh: "plain-refresh", expires: 7 } }),
		);

		const providers = [...api.migrateAuthToAuthJson()];

		assert.deepStrictEqual(providers, ["anthropic"], "a BOM-free oauth.json must still migrate");
		assert.deepStrictEqual(
			JSON.parse(read(authPathOf(agentDir))),
			{ anthropic: { type: "oauth", access: "plain-access", refresh: "plain-refresh", expires: 7 } },
			"BOM-free OAuth credentials must be preserved verbatim",
		);
	});

	// ---------------------------------------------------------------------
	// 6. BOM-prefixed settings.json stays a valid apiKeys fallback.
	// ---------------------------------------------------------------------
	await withAgentDir(async (api, agentDir) => {
		write(settingsPathOf(agentDir), `${BOM}${JSON.stringify({ apiKeys: { openai: "sk-bom" } })}`);

		const providers = [...api.migrateAuthToAuthJson()];

		assert.deepStrictEqual(providers, ["openai"], "a BOM-prefixed settings.json apiKeys fallback must migrate");
		assert.deepStrictEqual(
			JSON.parse(read(authPathOf(agentDir))),
			{ openai: { type: "api_key", key: "sk-bom" } },
			"the api_key entry must be preserved",
		);
	});
} finally {
	rmSync(scratchRoot, { recursive: true, force: true });
}

console.log("migrateAuthToAuthJson regression: all assertions passed");
