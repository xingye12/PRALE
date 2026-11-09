/**
 * Regression: legacy oauth.json with a UTF-8 BOM must still migrate into auth.json.
 *
 * Exercises the real `migrateAuthToAuthJson()` from
 * packages/coding-agent/src/migrations.ts (loaded through the read-only
 * .prale-eval/subject.mjs helper with fs/path left real and only config
 * boundaries faked). Every check is a hard assertion:
 *  - valid BOM-prefixed oauth.json migrates (this is the stage's original fault),
 *  - API-key fallback from settings.json.apiKeys keeps working,
 *  - OAuth credentials win over a colliding API key,
 *  - malformed input is never renamed/rewritten/destroyed,
 *  - a pre-existing auth.json is left byte-for-byte untouched.
 *
 * Run from the workspace root:
 *   node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { loadMigrations } from "./subject.mjs";

const root = process.cwd();
const sourcePath = path.join(root, "packages/coding-agent/src/migrations.ts");
if (!existsSync(sourcePath)) {
	throw new Error(`Cannot find production source at ${sourcePath}; run from the workspace root`);
}

const BOM = "\uFEFF";
const scratch = mkdtempSync(path.join(root, ".prale-eval", "tmp-"));
const cases = [];
let scratchIndex = 0;

/** Fresh agentDir + freshly loaded real migration module bound to it. */
async function newCase(files) {
	const agentDir = path.join(scratch, `case-${++scratchIndex}`);
	mkdirSync(agentDir, { recursive: true });
	for (const [name, contents] of Object.entries(files)) {
		writeFileSync(path.join(agentDir, name), contents);
	}
	const migrations = await loadMigrations(root, agentDir);
	return { agentDir, migrations };
}

// The migration module runs in its own VM realm, so its arrays/objects carry a
// foreign prototype: normalize before comparing with host-realm literals.
const plain = (value) => JSON.parse(JSON.stringify(value));
const readJson = (agentDir, name) => JSON.parse(readFileSync(path.join(agentDir, name), "utf-8"));
const raw = (agentDir, name) => readFileSync(path.join(agentDir, name), "utf-8");
const has = (agentDir, name) => existsSync(path.join(agentDir, name));

async function check(name, body) {
	cases.push(name);
	await body();
}

try {
	// ---------------------------------------------------------------- baseline
	await check("oauth.json without BOM still migrates (baseline)", async () => {
		const oauth = { anthropic: { access: "plain-access", refresh: "plain-refresh" } };
		const { agentDir, migrations } = await newCase({ "oauth.json": JSON.stringify(oauth) });
		const providers = migrations.migrateAuthToAuthJson();
		assert.deepEqual(plain(providers), ["anthropic"], "plain oauth.json providers");
		assert.deepEqual(
			readJson(agentDir, "auth.json"),
			{ anthropic: { type: "oauth", access: "plain-access", refresh: "plain-refresh" } },
			"plain oauth.json credentials",
		);
	});

	// ------------------------------------------------ stage fault: BOM + oauth
	await check("oauth.json with a UTF-8 BOM migrates its OAuth credentials", async () => {
		const oauth = {
			anthropic: { access: "bom-access", refresh: "bom-refresh", expires: 1700000000000 },
			"openai-codex": { access: "codex-access", refresh: "codex-refresh", expires: 1700000000001 },
		};
		const original = `${BOM}${JSON.stringify(oauth, null, 2)}`;
		const { agentDir, migrations } = await newCase({ "oauth.json": original });

		const providers = migrations.migrateAuthToAuthJson();

		assert.deepEqual(plain(providers), ["anthropic", "openai-codex"], "BOM oauth.json must report migrated providers");
		assert.ok(has(agentDir, "auth.json"), "BOM oauth.json must produce auth.json");
		assert.deepEqual(
			readJson(agentDir, "auth.json"),
			{
				anthropic: { type: "oauth", access: "bom-access", refresh: "bom-refresh", expires: 1700000000000 },
				"openai-codex": {
					type: "oauth",
					access: "codex-access",
					refresh: "codex-refresh",
					expires: 1700000000001,
				},
			},
			"BOM oauth.json credentials must be preserved in auth.json",
		);
		const mode = statSync(path.join(agentDir, "auth.json")).mode & 0o777;
		assert.equal(mode & 0o600, 0o600, `auth.json must stay owner read/write only, got ${mode.toString(8)}`);

		assert.equal(has(agentDir, "oauth.json"), false, "migrated oauth.json must be moved aside");
		assert.ok(has(agentDir, "oauth.json.migrated"), "migrated oauth.json must be kept as oauth.json.migrated");
		assert.equal(raw(agentDir, "oauth.json.migrated"), original, "oauth.json.migrated must keep the original bytes");
	});

	await check("BOM oauth.json migrates even when settings.json also has apiKeys", async () => {
		const { agentDir, migrations } = await newCase({
			"oauth.json": `${BOM}${JSON.stringify({ anthropic: { access: "bom-access", refresh: "bom-refresh" } })}`,
			"settings.json": `${BOM}${JSON.stringify({ theme: "dark", apiKeys: { openai: "sk-openai" } })}`,
		});
		const providers = migrations.migrateAuthToAuthJson();
		assert.deepEqual(plain(providers), ["anthropic", "openai"], "both sources must be migrated side by side");
		assert.deepEqual(
			readJson(agentDir, "auth.json"),
			{
				anthropic: { type: "oauth", access: "bom-access", refresh: "bom-refresh" },
				openai: { type: "api_key", key: "sk-openai" },
			},
			"combined oauth + api key migration",
		);
	});

	// ------------------------------------------------------- API-key fallback
	await check("settings.json apiKeys still migrate when no oauth.json exists", async () => {
		const { agentDir, migrations } = await newCase({
			"settings.json": `${BOM}${JSON.stringify({ theme: "dark", apiKeys: { openai: "sk-openai", groq: "sk-groq" } })}`,
		});
		const providers = migrations.migrateAuthToAuthJson();
		assert.deepEqual(plain(providers), ["openai", "groq"], "api key providers");
		assert.deepEqual(
			readJson(agentDir, "auth.json"),
			{ openai: { type: "api_key", key: "sk-openai" }, groq: { type: "api_key", key: "sk-groq" } },
			"api key fallback credentials",
		);
		assert.deepEqual(readJson(agentDir, "settings.json"), { theme: "dark" }, "apiKeys must be removed from settings");
		assert.equal(has(agentDir, "oauth.json"), false, "no oauth.json should be invented");
	});

	// ------------------------------------------------------ OAuth precedence
	await check("OAuth credentials take precedence over colliding apiKeys", async () => {
		const { agentDir, migrations } = await newCase({
			"oauth.json": `${BOM}${JSON.stringify({ anthropic: { access: "bom-access", refresh: "bom-refresh" } })}`,
			"settings.json": JSON.stringify({ apiKeys: { anthropic: "sk-should-lose", openai: "sk-openai" } }),
		});
		migrations.migrateAuthToAuthJson();
		const auth = readJson(agentDir, "auth.json");
		assert.deepEqual(
			auth.anthropic,
			{ type: "oauth", access: "bom-access", refresh: "bom-refresh" },
			"oauth must win over the colliding api key",
		);
		assert.deepEqual(auth.openai, { type: "api_key", key: "sk-openai" }, "non-colliding api key must still migrate");
		assert.deepEqual(readJson(agentDir, "settings.json"), {}, "apiKeys block is consumed by the migration");
	});

	// ------------------------------------------------- malformed input safety
	await check("malformed oauth.json is never destroyed", async () => {
		const broken = `${BOM}{"anthropic": {"access": "truncated"`;
		const { agentDir, migrations } = await newCase({ "oauth.json": broken });
		let providers;
		assert.doesNotThrow(() => {
			providers = migrations.migrateAuthToAuthJson();
		}, "malformed oauth.json must not throw");
		assert.deepEqual(plain(providers), [], "malformed oauth.json must not report providers");
		assert.ok(has(agentDir, "oauth.json"), "malformed oauth.json must be left in place");
		assert.equal(raw(agentDir, "oauth.json"), broken, "malformed oauth.json content must be preserved verbatim");
		assert.equal(has(agentDir, "oauth.json.migrated"), false, "malformed oauth.json must not be renamed");
		assert.equal(has(agentDir, "auth.json"), false, "nothing migratable means no auth.json");
	});

	await check("malformed oauth.json keeps the API-key fallback available", async () => {
		const broken = `${BOM}{not json at all`;
		const settings = { theme: "dark", apiKeys: { openai: "sk-openai" } };
		const { agentDir, migrations } = await newCase({
			"oauth.json": broken,
			"settings.json": JSON.stringify(settings),
		});
		const providers = migrations.migrateAuthToAuthJson();
		assert.deepEqual(plain(providers), ["openai"], "api key fallback still migrates");
		assert.equal(raw(agentDir, "oauth.json"), broken, "malformed oauth.json content must be preserved verbatim");
		assert.equal(has(agentDir, "oauth.json.migrated"), false, "malformed oauth.json must not be renamed");
	});

	await check("malformed settings.json is never rewritten", async () => {
		const brokenSettings = `${BOM}{"apiKeys": {"openai": `;
		const { agentDir, migrations } = await newCase({
			"oauth.json": `${BOM}${JSON.stringify({ anthropic: { access: "bom-access", refresh: "bom-refresh" } })}`,
			"settings.json": brokenSettings,
		});
		const providers = migrations.migrateAuthToAuthJson();
		assert.deepEqual(plain(providers), ["anthropic"], "oauth still migrates past a broken settings.json");
		assert.equal(raw(agentDir, "settings.json"), brokenSettings, "malformed settings.json must be preserved");
	});

	// ---------------------------------------------- existing auth.json guarded
	await check("an existing auth.json is left untouched and short-circuits migration", async () => {
		const existingAuth = `${JSON.stringify({ anthropic: { type: "api_key", key: "existing" } }, null, 2)}\n`;
		const { agentDir, migrations } = await newCase({
			"auth.json": existingAuth,
			"oauth.json": `${BOM}${JSON.stringify({ anthropic: { access: "bom-access" } })}`,
			"settings.json": JSON.stringify({ apiKeys: { openai: "sk-openai" } }),
		});
		const providers = migrations.migrateAuthToAuthJson();
		assert.deepEqual(plain(providers), [], "existing auth.json means nothing is migrated");
		assert.equal(raw(agentDir, "auth.json"), existingAuth, "existing auth.json must be byte-for-byte untouched");
		assert.ok(has(agentDir, "oauth.json"), "legacy oauth.json must not be consumed when auth.json exists");
		assert.equal(has(agentDir, "oauth.json.migrated"), false, "legacy oauth.json must not be renamed");
		assert.deepEqual(
			readJson(agentDir, "settings.json"),
			{ apiKeys: { openai: "sk-openai" } },
			"settings.json must not be rewritten when auth.json exists",
		);
	});

	// --------------------------------------------------- idempotent re-run
	await check("re-running the migration after a BOM migration is a no-op", async () => {
		const { agentDir, migrations } = await newCase({
			"oauth.json": `${BOM}${JSON.stringify({ anthropic: { access: "bom-access", refresh: "bom-refresh" } })}`,
		});
		migrations.migrateAuthToAuthJson();
		const afterFirst = raw(agentDir, "auth.json");
		const providers = migrations.migrateAuthToAuthJson();
		assert.deepEqual(plain(providers), [], "second run must migrate nothing");
		assert.equal(raw(agentDir, "auth.json"), afterFirst, "auth.json must be stable across runs");
	});

	console.log(`ok - ${cases.length} migration regression cases passed`);
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
