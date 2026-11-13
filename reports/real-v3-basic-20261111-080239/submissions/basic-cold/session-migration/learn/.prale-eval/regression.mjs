/**
 * Regression for session-migration/learn:
 * a legacy oauth.json written with a UTF-8 BOM must still migrate into auth.json,
 * while OAuth precedence, settings.json api-key fallback, preservation of
 * malformed input and the "existing auth.json is untouched" rule all hold.
 *
 * Exercises the real production module
 * `packages/coding-agent/src/migrations.ts` (and the real `stripBom` helper from
 * `packages/coding-agent/src/utils/text.ts`) through the read-only subject
 * helper, with an in-memory `fs` boundary fake.
 *
 * Run from the workspace root:
 *   node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGraph } from "./subject.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const MIGRATIONS = "packages/coding-agent/src/migrations.ts";
const TEXT = "packages/coding-agent/src/utils/text.ts";

const AGENT_DIR = "/fake-home/.pi/agent";
const AUTH_PATH = `${AGENT_DIR}/auth.json`;
const OAUTH_PATH = `${AGENT_DIR}/oauth.json`;
const SETTINGS_PATH = `${AGENT_DIR}/settings.json`;
const BOM = "\uFEFF";

/** Minimal in-memory stand-in for the `fs` boundary used by migrations.ts. */
function createFakeFs(initialFiles) {
	const files = new Map(Object.entries(initialFiles));
	const calls = { writes: [], renames: [], mkdirs: [], removed: [] };
	const missing = (operation, target) => {
		const error = new Error(`ENOENT: no such file or directory, ${operation} '${target}'`);
		error.code = "ENOENT";
		return error;
	};
	const fs = {
		existsSync: (target) => files.has(target),
		readFileSync: (target) => {
			if (!files.has(target)) throw missing("open", target);
			return files.get(target);
		},
		writeFileSync: (target, data) => {
			files.set(target, String(data));
			calls.writes.push({ target, data: String(data) });
		},
		mkdirSync: (target) => {
			calls.mkdirs.push(target);
		},
		renameSync: (from, to) => {
			if (!files.has(from)) throw missing("rename", from);
			files.set(to, files.get(from));
			files.delete(from);
			calls.renames.push({ from, to });
		},
		rmSync: (target) => {
			files.delete(target);
			calls.removed.push(target);
		},
		readdirSync: (target) => {
			if (!files.has(target)) throw missing("scandir", target);
			return [];
		},
	};
	return { files, calls, fs };
}

/**
 * Load the real migrations module with the real stripBom helper linked in.
 * Only config lookup, keybindings migration, chalk and `fs` are faked.
 */
async function loadMigrations(fakeFs) {
	const graph = createGraph(
		root,
		[MIGRATIONS, TEXT],
		{
			CONFIG_DIR_NAME: ".pi",
			getAgentDir: () => AGENT_DIR,
			getBinDir: () => `${AGENT_DIR}/bin`,
			migrateKeybindingsConfig: () => ({ config: {}, migrated: false }),
			// chalk default export used by code paths outside this test
			default: { green: (value) => value, yellow: (value) => value, dim: (value) => value },
		},
		{
			[MIGRATIONS]: {
				existsSync: fakeFs.existsSync,
				readFileSync: fakeFs.readFileSync,
				writeFileSync: fakeFs.writeFileSync,
				mkdirSync: fakeFs.mkdirSync,
				renameSync: fakeFs.renameSync,
				rmSync: fakeFs.rmSync,
				readdirSync: fakeFs.readdirSync,
			},
		},
	);
	return graph.module(MIGRATIONS);
}

async function runMigration(initialFiles) {
	const { files, calls, fs } = createFakeFs(initialFiles);
	const namespace = await loadMigrations(fs);
	assert.equal(
		typeof namespace.migrateAuthToAuthJson,
		"function",
		"production module must export migrateAuthToAuthJson",
	);
	// Copy into a host-realm array: the module runs in a separate VM context.
	const providers = Array.from(namespace.migrateAuthToAuthJson(), (provider) => String(provider));
	return { providers, files, calls };
}

function readJson(files, target) {
	assert.ok(files.has(target), `expected ${target} to exist`);
	return JSON.parse(files.get(target));
}

const oauthCredentials = { refresh: "refresh-token", access: "access-token", expires: 1730000000000 };
const oauthJsonText = JSON.stringify({ anthropic: oauthCredentials }, null, 2);
const bomOauthJsonText = `${BOM}${oauthJsonText}`;

// ---------------------------------------------------------------------------
// 1. The original fault: oauth.json saved with a UTF-8 BOM must migrate.
// ---------------------------------------------------------------------------
{
	const { providers, files, calls } = await runMigration({ [OAUTH_PATH]: bomOauthJsonText });

	assert.deepEqual(
		providers,
		["anthropic"],
		"a BOM-prefixed oauth.json must still be migrated into auth.json",
	);
	assert.deepEqual(
		readJson(files, AUTH_PATH),
		{ anthropic: { type: "oauth", ...oauthCredentials } },
		"OAuth credentials from a BOM-prefixed oauth.json must be preserved verbatim",
	);
	assert.deepEqual(
		calls.renames,
		[{ from: OAUTH_PATH, to: `${OAUTH_PATH}.migrated` }],
		"migrated oauth.json must be renamed to oauth.json.migrated",
	);
	assert.equal(
		files.get(`${OAUTH_PATH}.migrated`),
		bomOauthJsonText,
		"the retired oauth.json must be kept byte-for-byte",
	);
	assert.equal(files.has(SETTINGS_PATH), false, "no settings.json means no settings write");
}

// ---------------------------------------------------------------------------
// 2. OAuth precedence over settings.json apiKeys, with api-key fallback for
//    providers that have no legacy OAuth credential.
// ---------------------------------------------------------------------------
{
	const settingsText = JSON.stringify({ theme: "dark", apiKeys: { anthropic: "stale-key", openai: "sk-openai" } });
	const { providers, files } = await runMigration({
		[OAUTH_PATH]: bomOauthJsonText,
		[SETTINGS_PATH]: settingsText,
	});

	assert.deepEqual(providers, ["anthropic", "openai"], "both sources must report migrated providers");

	const auth = readJson(files, AUTH_PATH);
	assert.deepEqual(
		auth.anthropic,
		{ type: "oauth", ...oauthCredentials },
		"OAuth credentials must win over a settings.json api key for the same provider",
	);
	assert.equal("key" in auth.anthropic, false, "the losing api key must not leak into the OAuth credential");
	assert.deepEqual(auth.openai, { type: "api_key", key: "sk-openai" }, "api-key fallback must migrate");

	const settings = readJson(files, SETTINGS_PATH);
	assert.equal("apiKeys" in settings, false, "migrated apiKeys must be removed from settings.json");
	assert.deepEqual(settings, { theme: "dark" }, "other settings keys must be preserved");
}

// ---------------------------------------------------------------------------
// 3. Malformed oauth.json must not be destroyed; api keys still migrate.
// ---------------------------------------------------------------------------
{
	const malformed = `{ "anthropic": ${BOM}not-json,,, `;
	const { providers, files, calls } = await runMigration({
		[OAUTH_PATH]: malformed,
		[SETTINGS_PATH]: JSON.stringify({ apiKeys: { openai: "sk-openai" } }),
	});

	assert.deepEqual(providers, ["openai"], "api-key fallback must still run when oauth.json is malformed");
	assert.equal(files.get(OAUTH_PATH), malformed, "malformed oauth.json must be left untouched");
	assert.equal(files.has(`${OAUTH_PATH}.migrated`), false, "malformed oauth.json must not be renamed");
	assert.deepEqual(
		calls.renames.filter((rename) => rename.from === OAUTH_PATH),
		[],
		"no rename may target the malformed oauth.json",
	);
	assert.deepEqual(
		readJson(files, AUTH_PATH),
		{ openai: { type: "api_key", key: "sk-openai" } },
		"malformed oauth.json must not contribute partial credentials",
	);
}

// ---------------------------------------------------------------------------
// 4. An existing auth.json is authoritative: nothing is migrated or touched.
// ---------------------------------------------------------------------------
{
	const existingAuth = `${JSON.stringify({ anthropic: { type: "api_key", key: "keep-me" } }, null, 2)}\n`;
	const settingsText = JSON.stringify({ theme: "light", apiKeys: { anthropic: "old", openai: "old" } });
	const { providers, files, calls } = await runMigration({
		[AUTH_PATH]: existingAuth,
		[OAUTH_PATH]: bomOauthJsonText,
		[SETTINGS_PATH]: settingsText,
	});

	assert.deepEqual(providers, [], "an existing auth.json must short-circuit the migration");
	assert.equal(files.get(AUTH_PATH), existingAuth, "an existing auth.json must remain byte-identical");
	assert.equal(files.get(OAUTH_PATH), bomOauthJsonText, "oauth.json must not be renamed when auth.json exists");
	assert.equal(files.get(SETTINGS_PATH), settingsText, "settings.json must not be rewritten when auth.json exists");
	assert.deepEqual(calls.writes, [], "no file may be written when auth.json already exists");
	assert.deepEqual(calls.renames, [], "no file may be renamed when auth.json already exists");
}

// ---------------------------------------------------------------------------
// 5. oauth.json without a BOM keeps working (no regression of the happy path).
// ---------------------------------------------------------------------------
{
	const { providers, files } = await runMigration({ [OAUTH_PATH]: oauthJsonText });
	assert.deepEqual(providers, ["anthropic"], "plain oauth.json must still migrate");
	assert.deepEqual(
		readJson(files, AUTH_PATH),
		{ anthropic: { type: "oauth", ...oauthCredentials } },
		"plain oauth.json credentials must be preserved",
	);
}

console.log("session-migration/learn regression: all assertions passed");
