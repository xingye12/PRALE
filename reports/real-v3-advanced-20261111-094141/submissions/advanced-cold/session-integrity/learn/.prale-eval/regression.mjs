#!/usr/bin/env node
/**
 * Boundary regression for the legacy credential migration incident.
 *
 * Real production modules linked by the graph:
 *   - packages/coding-agent/src/utils/text.ts        (BOM decoding helper)
 *   - packages/coding-agent/src/utils/frontmatter.ts (second consumer of stripBom)
 *   - packages/coding-agent/src/migrations.ts        (oauth.json + settings.json -> auth.json merge)
 *
 * Everything else (chalk, yaml, ./config.ts, ./core/keybindings.ts) is a
 * boundary fake supplied below. File system access uses the real `fs` builtin
 * against throwaway directories under .prale-eval/, removed on exit.
 *
 * Run from the workspace root:
 *   node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGraph } from "./subject.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEXT_MODULE = "packages/coding-agent/src/utils/text.ts";
const FRONTMATTER_MODULE = "packages/coding-agent/src/utils/frontmatter.ts";
const MIGRATIONS_MODULE = "packages/coding-agent/src/migrations.ts";
const TMP_ROOT = join(ROOT, ".prale-eval", "tmp-regression");
const BOM = "\uFEFF";

/** Minimal stand-in for the `yaml` boundary used by frontmatter.ts. */
function parseSimpleYaml(source) {
	const parsed = {};
	for (const line of String(source).split("\n")) {
		const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
		if (!match) continue;
		parsed[match[1]] = match[2].trim().replace(/^["'](.*)["']$/, "$1");
	}
	return parsed;
}

let agentDir = "";
const chalkFake = {
	green: (value) => String(value),
	yellow: (value) => String(value),
	dim: (value) => String(value),
};

const graph = createGraph(ROOT, [TEXT_MODULE, FRONTMATTER_MODULE, MIGRATIONS_MODULE], {
	default: chalkFake,
	CONFIG_DIR_NAME: ".pi",
	getAgentDir: () => agentDir,
	getBinDir: () => join(agentDir, "bin"),
	migrateKeybindingsConfig: () => ({ config: {}, migrated: false }),
	parse: parseSimpleYaml,
});

const text = await graph.module(TEXT_MODULE);
const frontmatter = await graph.module(FRONTMATTER_MODULE);
const migrations = await graph.module(MIGRATIONS_MODULE);

/** Values produced inside the VM context have foreign prototypes; normalize them. */
const plain = (value) => JSON.parse(JSON.stringify(value));

function resetAgentDir(name) {
	rmSync(TMP_ROOT, { recursive: true, force: true });
	agentDir = join(TMP_ROOT, name);
	mkdirSync(agentDir, { recursive: true });
	return agentDir;
}

const readJson = (file) => JSON.parse(readFileSync(file, "utf-8"));
const result = () => plain(migrations.migrateAuthToAuthJson());

process.on("exit", () => rmSync(TMP_ROOT, { recursive: true, force: true }));

// ---------------------------------------------------------------- text utility
// Only a leading BOM is removed; plain and interior-BOM text survives untouched.
assert.equal(text.stripBom("plain text"), "plain text");
assert.equal(text.stripBom(`${BOM}plain text`), "plain text");
assert.equal(text.stripBom(`in${BOM}terior`), `in${BOM}terior`);
assert.equal(text.stripBom(`${BOM}he${BOM}llo`), `he${BOM}llo`);
assert.equal(text.stripBom(BOM), "");
assert.equal(text.stripBom(""), "");
assert.deepEqual(plain(text.splitBom(`${BOM}body`)), { bom: BOM, text: "body" });
assert.deepEqual(plain(text.splitBom("body")), { bom: "", text: "body" });
assert.equal(text.stripBom(`${BOM}{"theme":"dark"}`), '{"theme":"dark"}');
assert.deepEqual(JSON.parse(text.stripBom(`${BOM}{"theme":"dark"}`)), { theme: "dark" });

// ------------------------------------------------------------------- consumer
// frontmatter.ts is a second independent consumer of stripBom: a BOM-prefixed
// document must parse exactly like the same document without a BOM.
const document = "---\nname: demo\ndescription: Test\n---\nBody";
assert.deepEqual(plain(frontmatter.parseFrontmatter(document)), {
	frontmatter: { name: "demo", description: "Test" },
	body: "Body",
});
assert.deepEqual(plain(frontmatter.parseFrontmatter(`${BOM}${document}`)), {
	frontmatter: { name: "demo", description: "Test" },
	body: "Body",
});

// --------------------------------------------------- incident: BOM + merge policy
// BOM-encoded oauth.json and settings.json must both migrate; the settings API
// key for the OAuth provider must lose; unrelated settings stay; OAuth input is
// archived as oauth.json.migrated.
{
	const dir = resetAgentDir("bom-mixed");
	const oauthCredential = { access: "oauth-access", refresh: "oauth-refresh", expires: 1893456000 };
	const oauthRaw = `${BOM}${JSON.stringify(
		{ anthropic: oauthCredential, github: { access: "gh-access", refresh: "gh-refresh", expires: 1893456001 } },
		null,
		2,
	)}`;
	const settingsRaw = `${BOM}${JSON.stringify(
		{ theme: "dark", defaultModel: "claude-sonnet", apiKeys: { anthropic: "sk-legacy-anthropic", openai: "sk-legacy-openai" } },
		null,
		2,
	)}`;
	writeFileSync(join(dir, "oauth.json"), oauthRaw);
	writeFileSync(join(dir, "settings.json"), settingsRaw);

	const providers = result();
	assert.deepEqual([...providers].sort(), ["anthropic", "github", "openai"]);

	const authPath = join(dir, "auth.json");
	assert.ok(existsSync(authPath), "BOM-encoded legacy credentials must still produce auth.json");
	assert.deepEqual(readJson(authPath), {
		anthropic: { type: "oauth", ...oauthCredential },
		github: { type: "oauth", access: "gh-access", refresh: "gh-refresh", expires: 1893456001 },
		openai: { type: "api_key", key: "sk-legacy-openai" },
	});

	assert.equal(existsSync(join(dir, "oauth.json")), false, "migrated oauth.json is archived");
	assert.equal(readFileSync(join(dir, "oauth.json.migrated"), "utf-8"), oauthRaw, "archive keeps original bytes");
	assert.deepEqual(readJson(join(dir, "settings.json")), { theme: "dark", defaultModel: "claude-sonnet" });

	// A second run finds auth.json and must not migrate anything again.
	assert.deepEqual(result(), []);
}

// ------------------------------------------- plain text input keeps full fidelity
{
	const dir = resetAgentDir("plain-text");
	writeFileSync(
		join(dir, "oauth.json"),
		JSON.stringify({ anthropic: { access: "a", refresh: "r", expires: 5 } }),
	);
	writeFileSync(
		join(dir, "settings.json"),
		JSON.stringify({ theme: "light", defaultModel: "m", apiKeys: { anthropic: "sk-loses", openai: "sk-wins" } }),
	);
	assert.deepEqual([...result()].sort(), ["anthropic", "openai"]);
	assert.deepEqual(readJson(join(dir, "auth.json")), {
		anthropic: { type: "oauth", access: "a", refresh: "r", expires: 5 },
		openai: { type: "api_key", key: "sk-wins" },
	});
	assert.deepEqual(readJson(join(dir, "settings.json")), { theme: "light", defaultModel: "m" });
}

// ------------------------------------------- existing auth.json blocks migration
{
	const dir = resetAgentDir("existing-auth");
	const existingAuth = { custom: { type: "api_key", key: "existing-key" } };
	const existingRaw = JSON.stringify(existingAuth, null, 2);
	const oauthRaw = JSON.stringify({ anthropic: { access: "a", refresh: "r", expires: 9 } });
	const settingsRaw = JSON.stringify({ theme: "dark", apiKeys: { openai: "sk-e" } });
	writeFileSync(join(dir, "auth.json"), existingRaw);
	writeFileSync(join(dir, "oauth.json"), oauthRaw);
	writeFileSync(join(dir, "settings.json"), settingsRaw);

	assert.deepEqual(result(), [], "an existing auth.json disables credential migration");
	assert.equal(readFileSync(join(dir, "auth.json"), "utf-8"), existingRaw, "auth.json untouched");
	assert.equal(readFileSync(join(dir, "oauth.json"), "utf-8"), oauthRaw, "oauth.json not archived");
	assert.equal(existsSync(join(dir, "oauth.json.migrated")), false);
	assert.equal(readFileSync(join(dir, "settings.json"), "utf-8"), settingsRaw, "settings.json untouched");
}

// ------------------------------------------------ malformed oauth.json untouched
{
	const dir = resetAgentDir("malformed-oauth");
	const brokenOauth = `${BOM}{ "anthropic": `;
	writeFileSync(join(dir, "oauth.json"), brokenOauth);
	writeFileSync(join(dir, "settings.json"), JSON.stringify({ theme: "dark", apiKeys: { openai: "sk-openai" } }));

	assert.deepEqual(result(), ["openai"]);
	assert.equal(readFileSync(join(dir, "oauth.json"), "utf-8"), brokenOauth, "malformed oauth.json untouched");
	assert.equal(existsSync(join(dir, "oauth.json.migrated")), false, "malformed oauth.json is not archived");
	assert.deepEqual(readJson(join(dir, "auth.json")), { openai: { type: "api_key", key: "sk-openai" } });
}

// --------------------------------------------- malformed settings.json untouched
{
	const dir = resetAgentDir("malformed-settings");
	const brokenSettings = `${BOM}{ "apiKeys": `;
	writeFileSync(join(dir, "settings.json"), brokenSettings);
	writeFileSync(join(dir, "oauth.json"), JSON.stringify({ anthropic: { access: "a", refresh: "r", expires: 3 } }));

	assert.deepEqual(result(), ["anthropic"]);
	assert.equal(readFileSync(join(dir, "settings.json"), "utf-8"), brokenSettings, "malformed settings.json untouched");
	assert.deepEqual(readJson(join(dir, "auth.json")), {
		anthropic: { type: "oauth", access: "a", refresh: "r", expires: 3 },
	});
}

// ------------------------------------------------------- no legacy input, no work
{
	const dir = resetAgentDir("no-legacy");
	assert.deepEqual(result(), []);
	assert.equal(existsSync(join(dir, "auth.json")), false, "no credentials means no auth.json");
}

rmSync(TMP_ROOT, { recursive: true, force: true });
console.log("regression.mjs: all cross-module credential migration checks passed");
