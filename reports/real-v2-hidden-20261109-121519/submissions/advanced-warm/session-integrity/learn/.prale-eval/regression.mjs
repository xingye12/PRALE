/**
 * Regression coverage for the legacy credential migration incident.
 *
 * Loads the real submitted production modules through the read-only
 * `.prale-eval/subject.mjs` helper (real `migrations.ts`, real `utils/text.ts`,
 * real `session-manager.ts`; only `getAgentDir`/fs listing boundaries are
 * injected). Assertions come from `node:assert/strict` and are left uncaught so
 * a behavioural regression fails the process instead of crashing the harness.
 *
 * Temp fixtures are created under `.prale-eval/` and removed before exit.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createSessionPipeline } from "./subject.mjs";

const root = process.cwd();
const scratch = path.join(root, ".prale-eval", ".tmp-auth-migration");
const BOM = "\uFEFF";

let scenarioCount = 0;

/** Run one scenario in an isolated agent directory, then remove its fixture. */
async function scenario(name, files, run) {
	const agentDir = path.join(scratch, `case-${++scenarioCount}`);
	fs.mkdirSync(agentDir, { recursive: true });
	for (const [file, contents] of Object.entries(files)) {
		fs.writeFileSync(path.join(agentDir, file), contents, "utf-8");
	}
	const pipeline = await createSessionPipeline(root, agentDir);
	await run({ ...pipeline, agentDir, read: (file) => fs.readFileSync(path.join(agentDir, file), "utf-8"),
		exists: (file) => fs.existsSync(path.join(agentDir, file)) });
	fs.rmSync(agentDir, { recursive: true, force: true });
	console.log(`ok - ${name}`);
}

function readJson(agentDir, file) {
	return JSON.parse(fs.readFileSync(path.join(agentDir, file), "utf-8"));
}

function sorted(values) {
	return [...values].sort();
}

fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(scratch, { recursive: true });

try {
	// ---------------------------------------------------------------- text API
	await scenario("text helpers strip one leading BOM and keep everything else", {}, async ({ text }) => {
		const { splitBom, stripBom } = text;
		assert.equal(stripBom(`${BOM}hello`), "hello");
		assert.equal(stripBom("hello"), "hello");
		assert.equal(stripBom(""), "");
		// Interior BOM characters are data, not encoding noise.
		assert.equal(stripBom(`he${BOM}llo`), `he${BOM}llo`);
		assert.equal(stripBom(`{"a":"x${BOM}y"}`), `{"a":"x${BOM}y"}`);
		// Only the leading mark is removed; a second leading mark is content.
		assert.equal(stripBom(`${BOM}${BOM}keep`), `${BOM}keep`);
		// splitBom stays a lossless split for every shape above.
		for (const sample of [`${BOM}hello`, "hello", "", `he${BOM}llo`, `${BOM}${BOM}keep`]) {
			const split = splitBom(sample);
			assert.equal(split.bom + split.text, sample);
		}
		// Spread into the harness realm: vm module objects have their own prototype.
		assert.deepEqual({ ...splitBom(`${BOM}content`) }, { bom: BOM, text: "content" });
		assert.deepEqual({ ...splitBom("content") }, { bom: "", text: "content" });
	});

	// ------------------------------------------------- BOM fixtures + precedence
	await scenario(
		"BOM-encoded OAuth and settings apiKeys merge without losing credentials",
		{
			"oauth.json": `${BOM}${JSON.stringify({
				anthropic: { access: "oauth-access", refresh: "oauth-refresh", expires: 1767225600000 },
				"github-copilot": { access: "copilot-access", refresh: "copilot-refresh" },
			})}`,
			"settings.json": `${BOM}${JSON.stringify({
				defaultModel: `gpt-5${BOM}preview`,
				theme: "dark",
				compaction: { reserveTokens: 4096 },
				apiKeys: { anthropic: "sk-legacy-anthropic", openai: "sk-openai" },
			})}`,
		},
		async ({ migration, agentDir, exists }) => {
			const providers = migration.migrateAuthToAuthJson();

			// Both sources are found, and the overlapping provider is reported once.
			assert.deepEqual(sorted(providers), ["anthropic", "github-copilot", "openai"]);

			const auth = readJson(agentDir, "auth.json");
			assert.deepEqual(sorted(Object.keys(auth)), ["anthropic", "github-copilot", "openai"]);

			// OAuth wins for the same provider; the settings fallback never overwrites it.
			assert.equal(auth.anthropic.type, "oauth");
			assert.equal(auth.anthropic.access, "oauth-access");
			assert.equal(auth.anthropic.refresh, "oauth-refresh");
			assert.equal(auth.anthropic.expires, 1767225600000);
			assert.equal(auth.anthropic.key, undefined);

			assert.equal(auth["github-copilot"].type, "oauth");
			assert.equal(auth["github-copilot"].access, "copilot-access");

			// Non-overlapping settings keys still migrate.
			assert.deepEqual(auth.openai, { type: "api_key", key: "sk-openai" });

			// Unrelated settings survive, apiKeys is retired, interior BOM is kept.
			const settings = readJson(agentDir, "settings.json");
			assert.deepEqual(settings, {
				defaultModel: `gpt-5${BOM}preview`,
				theme: "dark",
				compaction: { reserveTokens: 4096 },
			});
			assert.equal(Object.hasOwn(settings, "apiKeys"), false);

			// The consumed OAuth input is archived byte-for-byte, not deleted.
			assert.equal(exists("oauth.json"), false);
			assert.equal(exists("oauth.json.migrated"), true);
			assert.equal(fs.readFileSync(path.join(agentDir, "oauth.json.migrated"), "utf-8"),
				`${BOM}${JSON.stringify({
					anthropic: { access: "oauth-access", refresh: "oauth-refresh", expires: 1767225600000 },
					"github-copilot": { access: "copilot-access", refresh: "copilot-refresh" },
				})}`);
		},
	);

	await scenario(
		"plain (BOM-free) inputs get the same precedence and settings retention",
		{
			"oauth.json": JSON.stringify({ anthropic: { access: "plain-oauth", refresh: "r" } }),
			"settings.json": JSON.stringify({
				defaultProvider: "openai",
				apiKeys: { anthropic: "sk-plain", openai: "sk-plain-openai" },
			}),
		},
		async ({ migration, agentDir, exists }) => {
			const providers = migration.migrateAuthToAuthJson();
			assert.deepEqual(sorted(providers), ["anthropic", "openai"]);

			const auth = readJson(agentDir, "auth.json");
			assert.equal(auth.anthropic.type, "oauth");
			assert.equal(auth.anthropic.access, "plain-oauth");
			assert.deepEqual(auth.openai, { type: "api_key", key: "sk-plain-openai" });

			assert.deepEqual(readJson(agentDir, "settings.json"), { defaultProvider: "openai" });
			assert.equal(exists("oauth.json"), false);
			assert.equal(exists("oauth.json.migrated"), true);
		},
	);

	// ------------------------------------------------- existing auth.json gate
	await scenario(
		"an existing auth.json blocks every credential migration",
		{
			"auth.json": `${JSON.stringify({ anthropic: { type: "api_key", key: "already-there" } }, null, 2)}\n`,
			"oauth.json": `${BOM}${JSON.stringify({ anthropic: { access: "oauth-access", refresh: "r" } })}`,
			"settings.json": `${BOM}${JSON.stringify({ theme: "light", apiKeys: { openai: "sk-openai" } })}`,
		},
		async ({ migration, agentDir }) => {
			const before = {
				auth: fs.readFileSync(path.join(agentDir, "auth.json"), "utf-8"),
				oauth: fs.readFileSync(path.join(agentDir, "oauth.json"), "utf-8"),
				settings: fs.readFileSync(path.join(agentDir, "settings.json"), "utf-8"),
			};

			assert.deepEqual(sorted(migration.migrateAuthToAuthJson()), []);

			assert.equal(fs.readFileSync(path.join(agentDir, "auth.json"), "utf-8"), before.auth);
			assert.equal(fs.readFileSync(path.join(agentDir, "oauth.json"), "utf-8"), before.oauth);
			assert.equal(fs.readFileSync(path.join(agentDir, "settings.json"), "utf-8"), before.settings);
			assert.equal(fs.existsSync(path.join(agentDir, "oauth.json.migrated")), false);
		},
	);

	// ---------------------------------------------------- malformed inputs stay
	await scenario(
		"malformed OAuth input is left untouched while api keys still migrate",
		{
			"oauth.json": `${BOM}{"anthropic": {"access": `,
			"settings.json": `${BOM}${JSON.stringify({ theme: "dark", apiKeys: { openai: "sk-openai" } })}`,
		},
		async ({ migration, agentDir, exists }) => {
			const oauthBytes = fs.readFileSync(path.join(agentDir, "oauth.json"), "utf-8");
			const providers = migration.migrateAuthToAuthJson();

			assert.deepEqual(sorted(providers), ["openai"]);
			assert.deepEqual(readJson(agentDir, "auth.json"), { openai: { type: "api_key", key: "sk-openai" } });
			// Malformed data is neither moved nor rewritten.
			assert.equal(exists("oauth.json.migrated"), false);
			assert.equal(fs.readFileSync(path.join(agentDir, "oauth.json"), "utf-8"), oauthBytes);
			assert.deepEqual(readJson(agentDir, "settings.json"), { theme: "dark" });
		},
	);

	await scenario(
		"malformed settings input is left untouched while OAuth migrates and archives",
		{
			"oauth.json": `${BOM}${JSON.stringify({ anthropic: { access: "oauth-access", refresh: "r" } })}`,
			"settings.json": `${BOM}{"theme": "dark", `,
		},
		async ({ migration, agentDir }) => {
			const settingsBytes = fs.readFileSync(path.join(agentDir, "settings.json"), "utf-8");
			const providers = migration.migrateAuthToAuthJson();

			assert.deepEqual(sorted(providers), ["anthropic"]);
			const auth = readJson(agentDir, "auth.json");
			assert.equal(auth.anthropic.type, "oauth");
			assert.equal(auth.anthropic.access, "oauth-access");
			assert.equal(fs.readFileSync(path.join(agentDir, "settings.json"), "utf-8"), settingsBytes);
			assert.equal(fs.existsSync(path.join(agentDir, "oauth.json.migrated")), true);
		},
	);

	// ------------------------------------------------------ no spurious writes
	await scenario(
		"settings without apiKeys never create auth.json or rewrite settings",
		{
			"settings.json": `${BOM}${JSON.stringify({ defaultModel: "sonnet", apiKeys: undefined })}`,
		},
		async ({ migration, agentDir }) => {
			const settingsBytes = fs.readFileSync(path.join(agentDir, "settings.json"), "utf-8");
			assert.deepEqual(sorted(migration.migrateAuthToAuthJson()), []);
			assert.equal(fs.existsSync(path.join(agentDir, "auth.json")), false);
			assert.equal(fs.readFileSync(path.join(agentDir, "settings.json"), "utf-8"), settingsBytes);
		},
	);

	// A second run over the already-migrated directory must be a no-op: the new
	// auth.json gate (not an empty oauth.json) is what protects the credentials.
	await scenario(
		"re-running migration after a successful merge is idempotent",
		{
			"oauth.json": `${BOM}${JSON.stringify({ anthropic: { access: "oauth-access", refresh: "r" } })}`,
			"settings.json": `${BOM}${JSON.stringify({ theme: "dark", apiKeys: { anthropic: "sk-legacy", openai: "sk-openai" } })}`,
		},
		async ({ migration, agentDir }) => {
			assert.deepEqual(sorted(migration.migrateAuthToAuthJson()), ["anthropic", "openai"]);
			const authBytes = fs.readFileSync(path.join(agentDir, "auth.json"), "utf-8");
			const settingsBytes = fs.readFileSync(path.join(agentDir, "settings.json"), "utf-8");

			assert.deepEqual(sorted(migration.migrateAuthToAuthJson()), []);

			assert.equal(fs.readFileSync(path.join(agentDir, "auth.json"), "utf-8"), authBytes);
			assert.equal(fs.readFileSync(path.join(agentDir, "settings.json"), "utf-8"), settingsBytes);
			assert.deepEqual(readJson(agentDir, "auth.json").anthropic, {
				type: "oauth",
				access: "oauth-access",
				refresh: "r",
			});
		},
	);

	console.log("regression.mjs: all credential migration checks passed");
} finally {
	fs.rmSync(scratch, { recursive: true, force: true });
}
