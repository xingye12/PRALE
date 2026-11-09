/**
 * Local regression for the legacy credential migration.
 *
 * Loads the submitted production modules through the read-only `.prale-eval/subject.mjs`
 * helper, so `migrations.ts` consumes the real `utils/text.ts`, the real `path`/`fs`
 * behaviour (against a throwaway agent directory inside `.prale-eval/`) and the real
 * session reader module graph. No network, no credentials, no real clock, no randomness.
 *
 * Run from the workspace root:
 *   node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createSessionPipeline } from "./subject.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const sandbox = path.join(root, ".prale-eval", "tmp");
const BOM = "\uFEFF";

fs.rmSync(sandbox, { recursive: true, force: true });
fs.mkdirSync(sandbox, { recursive: true });

/** Write `files` into a fresh agent dir, run the real migration, and report what is on disk. */
async function migrate(scenario, files) {
	const agentDir = path.join(sandbox, scenario);
	fs.mkdirSync(agentDir, { recursive: true });
	for (const [name, content] of Object.entries(files)) {
		fs.writeFileSync(path.join(agentDir, name), content, "utf8");
	}
	const pipeline = await createSessionPipeline(root, agentDir);
	const providers = pipeline.migration.migrateAuthToAuthJson();
	const read = (name) => {
		const file = path.join(agentDir, name);
		return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : undefined;
	};
	const authText = read("auth.json");
	return {
		agentDir,
		providers,
		text: pipeline.text,
		migration: pipeline.migration,
		session: pipeline.session,
		read,
		auth: authText === undefined ? undefined : JSON.parse(authText),
		json: (name) => {
			const raw = read(name);
			return raw === undefined ? undefined : JSON.parse(raw);
		},
	};
}

try {
	// ---------------------------------------------------------------------------------
	// 1. text.ts: leading BOM removed, plain and interior-BOM text preserved.
	// ---------------------------------------------------------------------------------
	{
		const { text } = await migrate("text-utility", {});
		assert.equal(typeof text.stripBom, "function", "text.ts must keep exporting stripBom");
		assert.equal(typeof text.splitBom, "function", "text.ts must keep exporting splitBom");

		assert.equal(text.stripBom("plain credentials"), "plain credentials", "plain text must be untouched");
		assert.equal(text.stripBom(""), "", "empty text must stay empty");
		assert.equal(text.stripBom(`${BOM}plain credentials`), "plain credentials", "a leading BOM must be removed");
		assert.equal(
			text.stripBom(`${BOM}${BOM}two markers`),
			`${BOM}two markers`,
			"only the single leading BOM may be removed",
		);
		assert.equal(text.stripBom(`in${BOM}terior`), `in${BOM}terior`, "interior BOMs must be preserved");
		assert.equal(text.stripBom(`trailing${BOM}`), `trailing${BOM}`, "a trailing BOM is not a leading BOM");

		// `splitBom` results come from the linked module realm, so compare their fields.
		const split = (value) => {
			const { bom, text: rest } = text.splitBom(value);
			return [bom, rest];
		};
		assert.deepEqual(split(`${BOM}{}`), [BOM, "{}"]);
		assert.deepEqual(split("{}"), ["", "{}"]);
		assert.deepEqual(split(`a${BOM}b`), ["", `a${BOM}b`]);

		// Producer/consumer contract: decoded legacy JSON is parseable, interior markers survive.
		const decoded = text.stripBom(`${BOM}{"key":"sk-a${BOM}b"}`);
		assert.deepEqual(JSON.parse(decoded), { key: `sk-a${BOM}b` });
	}

	// ---------------------------------------------------------------------------------
	// 2. BOM-encoded oauth.json and settings.json both migrate; unrelated settings survive.
	// ---------------------------------------------------------------------------------
	{
		const oauth = { anthropic: { access: "oauth-access", refresh: "oauth-refresh", expires: 1700 } };
		const settings = { defaultModel: "keep-me", theme: "dark", apiKeys: { groq: "gsk-plain" } };
		const run = await migrate("bom-inputs", {
			"oauth.json": BOM + JSON.stringify(oauth, null, 2),
			"settings.json": BOM + JSON.stringify(settings, null, 2),
		});

		assert.deepEqual([...run.providers], ["anthropic", "groq"], "both BOM-encoded sources must be migrated");
		assert.deepEqual(run.auth, {
			anthropic: { type: "oauth", access: "oauth-access", refresh: "oauth-refresh", expires: 1700 },
			groq: { type: "api_key", key: "gsk-plain" },
		});
		assert.equal(run.read("oauth.json"), undefined, "the archived oauth.json must be gone");
		assert.equal(
			run.read("oauth.json.migrated"),
			BOM + JSON.stringify(oauth, null, 2),
			"the original oauth.json bytes must be archived verbatim",
		);
		assert.deepEqual(
			run.json("settings.json"),
			{ defaultModel: "keep-me", theme: "dark" },
			"unrelated settings must be retained while apiKeys is consumed",
		);
	}

	// ---------------------------------------------------------------------------------
	// 3. OAuth wins over a same-provider API key; other providers still migrate once.
	// ---------------------------------------------------------------------------------
	{
		const run = await migrate("precedence", {
			"oauth.json": JSON.stringify({
				openai: { access: "oauth-openai", refresh: "refresh-openai" },
				anthropic: { access: "oauth-anthropic", refresh: "refresh-anthropic" },
			}),
			"settings.json": JSON.stringify({
				defaultModel: "project-model",
				apiKeys: { openai: "sk-legacy-openai", anthropic: "sk-legacy-anthropic", groq: "gsk-1" },
			}),
		});

		assert.equal(run.auth.openai.type, "oauth", "OAuth must not be overwritten by a same-provider API key");
		assert.equal(run.auth.openai.access, "oauth-openai");
		assert.equal(run.auth.openai.key, undefined, "the losing API key must not leak into auth.json");
		assert.equal(run.auth.anthropic.type, "oauth");
		assert.equal(run.auth.anthropic.access, "oauth-anthropic");
		assert.deepEqual(run.auth.groq, { type: "api_key", key: "gsk-1" });
		assert.deepEqual(
			[...run.providers].sort(),
			["anthropic", "groq", "openai"],
			"every migrated provider must be reported exactly once",
		);
		assert.equal(run.providers.length, 3, "overridden providers must not be reported twice");
		assert.deepEqual(run.json("settings.json"), { defaultModel: "project-model" });
		assert.equal(run.read("oauth.json"), undefined);
		assert.notEqual(run.read("oauth.json.migrated"), undefined, "successful OAuth input must be archived");
	}

	// ---------------------------------------------------------------------------------
	// 4. Interior BOMs in legacy payloads survive the round trip; plain input also migrates.
	// ---------------------------------------------------------------------------------
	{
		const run = await migrate("interior-bom", {
			"settings.json": BOM + JSON.stringify({ apiKeys: { localai: `sk-${BOM}interior` }, defaultModel: "m" }),
		});
		assert.deepEqual(run.auth, { localai: { type: "api_key", key: `sk-${BOM}interior` } });
		assert.deepEqual([...run.providers], ["localai"]);

		const plain = await migrate("plain-inputs", {
			"oauth.json": JSON.stringify({ google: { access: "a", refresh: "r" } }),
		});
		assert.deepEqual(plain.auth, { google: { type: "oauth", access: "a", refresh: "r" } });
		assert.deepEqual([...plain.providers], ["google"]);
	}

	// ---------------------------------------------------------------------------------
	// 5. Malformed oauth.json is left untouched, yet settings apiKeys still migrate.
	// ---------------------------------------------------------------------------------
	{
		const brokenOauth = `${BOM}{ "anthropic": { "access": "truncated" `;
		const run = await migrate("malformed-oauth-syntax", {
			"oauth.json": brokenOauth,
			"settings.json": JSON.stringify({ defaultModel: "m", apiKeys: { groq: "gsk-2" } }),
		});

		assert.equal(run.read("oauth.json"), brokenOauth, "malformed oauth.json must keep its exact bytes");
		assert.equal(run.read("oauth.json.migrated"), undefined, "malformed oauth.json must never be archived");
		assert.deepEqual(run.auth, { groq: { type: "api_key", key: "gsk-2" } });
		assert.deepEqual([...run.providers], ["groq"]);
		assert.deepEqual(run.json("settings.json"), { defaultModel: "m" });

		const wrongShape = `[{"provider":"anthropic"}]`;
		const shaped = await migrate("malformed-oauth-shape", {
			"oauth.json": wrongShape,
			"settings.json": JSON.stringify({ apiKeys: { groq: "gsk-3" } }),
		});
		assert.equal(shaped.read("oauth.json"), wrongShape, "a non-object oauth.json document must stay untouched");
		assert.equal(shaped.read("oauth.json.migrated"), undefined, "a non-object oauth.json must not be archived");
		assert.deepEqual(shaped.auth, { groq: { type: "api_key", key: "gsk-3" } });
		assert.deepEqual([...shaped.providers], ["groq"]);
	}

	// ---------------------------------------------------------------------------------
	// 6. Malformed settings.json is left untouched while OAuth still migrates and archives.
	// ---------------------------------------------------------------------------------
	{
		const brokenSettings = `${BOM}{ "defaultModel": "m", "apiKeys": `;
		const run = await migrate("malformed-settings", {
			"oauth.json": BOM + JSON.stringify({ anthropic: { access: "a", refresh: "r" } }),
			"settings.json": brokenSettings,
		});

		assert.deepEqual([...run.providers], ["anthropic"]);
		assert.deepEqual(run.auth, { anthropic: { type: "oauth", access: "a", refresh: "r" } });
		assert.equal(run.read("settings.json"), brokenSettings, "malformed settings.json must keep its exact bytes");
		assert.notEqual(run.read("oauth.json.migrated"), undefined, "valid OAuth input is archived regardless");
	}

	// ---------------------------------------------------------------------------------
	// 7. An existing auth.json blocks every credential migration.
	// ---------------------------------------------------------------------------------
	{
		const existing = { anthropic: { type: "api_key", key: "current-key" } };
		const oauthText = JSON.stringify({ openai: { access: "oauth-openai", refresh: "r" } });
		const settingsText = JSON.stringify({ defaultModel: "m", apiKeys: { groq: "gsk-4" } });
		const run = await migrate("existing-auth", {
			"auth.json": JSON.stringify(existing, null, 2),
			"oauth.json": oauthText,
			"settings.json": settingsText,
		});

		assert.deepEqual([...run.providers], [], "an existing auth.json must migrate nothing");
		assert.deepEqual(run.auth, existing, "the existing auth.json must not be modified");
		assert.equal(run.read("oauth.json"), oauthText, "oauth.json must not be archived when auth.json exists");
		assert.equal(run.read("oauth.json.migrated"), undefined);
		assert.equal(run.read("settings.json"), settingsText, "settings.json must not be rewritten when auth.json exists");
	}

	console.log("regression: all legacy credential migration checks passed");
} finally {
	fs.rmSync(sandbox, { recursive: true, force: true });
}
