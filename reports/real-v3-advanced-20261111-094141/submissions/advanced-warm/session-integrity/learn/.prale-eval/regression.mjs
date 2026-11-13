/**
 * Regression suite for the legacy credential upgrade incident.
 *
 * Real production modules linked by the subject helper:
 *   - packages/coding-agent/src/utils/text.ts          (BOM input utility)
 *   - packages/coding-agent/src/migrations.ts          (legacy oauth.json / settings.json apiKeys migration)
 *   - packages/coding-agent/src/core/auth-storage.ts   (consumer of the migrated auth.json)
 *
 * Everything else (chalk, config paths, auth resolution, path/revision helpers,
 * lockfile) is a caller-supplied boundary fake, so the assertions only observe
 * behavior that crosses the real producer -> real consumer boundaries.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createGraph, loadModule } from "./subject.mjs";

const ROOT = process.cwd();
const WORK = join(ROOT, ".prale-eval", ".regression-work");
const BOM = "\uFEFF";

const TEXT_MODULE = "packages/coding-agent/src/utils/text.ts";
const MIGRATIONS_MODULE = "packages/coding-agent/src/migrations.ts";
const AUTH_STORAGE_MODULE = "packages/coding-agent/src/core/auth-storage.ts";

// Temporary inputs live inside the workspace and are removed on exit.
rmSync(WORK, { recursive: true, force: true });
process.on("exit", () => rmSync(WORK, { recursive: true, force: true }));

/** Values crossing the VM boundary carry a foreign realm prototype; normalize before comparing. */
const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

function freshDir(name) {
	const dir = join(WORK, name);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Link the real BOM utility with the real migration module; config/chalk are boundary fakes. */
async function loadMigrations(agentDir) {
	const graph = createGraph(ROOT, [TEXT_MODULE, MIGRATIONS_MODULE], {
		getAgentDir: () => agentDir,
		getBinDir: () => join(agentDir, "bin"),
		CONFIG_DIR_NAME: ".pi",
		migrateKeybindingsConfig: (config) => ({ config, migrated: false }),
		default: { green: (text) => text, yellow: (text) => text, dim: (text) => text },
	});
	return graph.module(MIGRATIONS_MODULE);
}

/** Link the real BOM utility with the real credential store that consumes auth.json. */
async function loadAuthStorage(agentDir) {
	const graph = createGraph(ROOT, [TEXT_MODULE, AUTH_STORAGE_MODULE], {
		getAgentDir: () => agentDir,
		normalizePath: (value) => value,
		getFileRevision: () => undefined,
		raceWithAbortSignal: (promise) => promise,
		isCommandConfigValue: () => false,
		resolveConfigValue: (value) => value,
		default: {
			lock: async () => async () => {},
			lockSync: () => () => {},
		},
	});
	return graph.module(AUTH_STORAGE_MODULE);
}

/** read() must resolve, never reject: a thrown boundary error is a failed assertion, not a crash. */
async function readCredential(storage, provider) {
	try {
		return { ok: true, value: plain(await storage.read(provider)) };
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error) };
	}
}

const OAUTH_CREDENTIAL = { access: "oauth-access", refresh: "oauth-refresh", expires: 1893456000000 };

// ---------------------------------------------------------------------------
// 1. BOM-encoded OAuth + settings API keys: nothing disappears, OAuth wins,
//    unrelated settings survive, oauth.json is archived, consumer can read it.
// ---------------------------------------------------------------------------
{
	const dir = freshDir("bom-oauth-and-settings");
	const oauthPath = join(dir, "oauth.json");
	const settingsPath = join(dir, "settings.json");
	const authPath = join(dir, "auth.json");

	const oauthText = `${BOM}${JSON.stringify({ anthropic: OAUTH_CREDENTIAL })}`;
	const settingsText = `${BOM}${JSON.stringify({
		theme: "solarized",
		editor: { tabSize: 2 },
		label: `${BOM}interior-only`,
		apiKeys: {
			anthropic: "sk-legacy-anthropic",
			openai: "sk-plain-openai",
			local: `sk-mid${BOM}dle`,
		},
	})}`;
	writeFileSync(oauthPath, oauthText);
	writeFileSync(settingsPath, settingsText);

	const migrations = await loadMigrations(dir);
	const providers = plain(migrations.migrateAuthToAuthJson());
	assert.deepEqual(
		providers,
		["anthropic", "openai", "local"],
		"BOM-encoded OAuth and same-provider API keys must each migrate exactly once",
	);

	assert.equal(existsSync(authPath), true, "BOM-encoded legacy credentials must produce auth.json");
	const authText = readFileSync(authPath, "utf8");
	assert.equal(authText.startsWith(BOM), false, "auth.json must be written without a leading BOM");
	const auth = JSON.parse(authText);
	assert.deepEqual(auth.anthropic, { ...OAUTH_CREDENTIAL, type: "oauth" }, "OAuth must win over the API key fallback");
	assert.deepEqual(auth.openai, { type: "api_key", key: "sk-plain-openai" });
	assert.deepEqual(auth.local, { type: "api_key", key: `sk-mid${BOM}dle` }, "interior BOMs stay inside migrated keys");

	assert.equal(existsSync(oauthPath), false, "successfully migrated oauth.json is archived by rename");
	assert.equal(readFileSync(`${oauthPath}.migrated`, "utf8"), oauthText, "archived OAuth input keeps its bytes");

	const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
	assert.equal(settings.theme, "solarized", "unrelated settings must be retained");
	assert.deepEqual(settings.editor, { tabSize: 2 }, "unrelated nested settings must be retained");
	assert.equal(settings.label, `${BOM}interior-only`, "a BOM inside a settings value must not be stripped");
	assert.equal(Object.hasOwn(settings, "apiKeys"), false, "migrated apiKeys are removed from settings");

	// Consumer boundary: the credential store must read what the migration wrote.
	const { ReadOnlyAuthStorage } = await loadAuthStorage(dir);
	const storage = new ReadOnlyAuthStorage(authPath);
	const [local, oauth, key] = await Promise.all([
		readCredential(storage, "local"),
		readCredential(storage, "anthropic"),
		readCredential(storage, "openai"),
	]);
	assert.deepEqual(local, { ok: true, value: { type: "api_key", key: `sk-mid${BOM}dle` } });
	assert.deepEqual(oauth, { ok: true, value: { ...OAUTH_CREDENTIAL, type: "oauth" } });
	assert.deepEqual(key, { ok: true, value: { type: "api_key", key: "sk-plain-openai" } });

	const listed = plain(await storage.list());
	assert.deepEqual(listed, [
		{ providerId: "anthropic", type: "oauth" },
		{ providerId: "openai", type: "api_key" },
		{ providerId: "local", type: "api_key" },
	]);
}

// ---------------------------------------------------------------------------
// 2. The input utility: only one leading BOM is removed, plain and interior
//    text are untouched, and BOM-free legacy files still migrate unchanged.
// ---------------------------------------------------------------------------
{
	const text = await loadModule(ROOT, TEXT_MODULE);
	assert.equal(text.stripBom("plain-text"), "plain-text", "plain text must be preserved");
	assert.equal(text.stripBom(`${BOM}plain-text`), "plain-text", "a leading BOM must be removed");
	assert.equal(text.stripBom(`${BOM}${BOM}twice`), `${BOM}twice`, "only one leading BOM is removed");
	assert.equal(text.stripBom(`in${BOM}terior`), `in${BOM}terior`, "interior BOMs must be preserved");
	assert.equal(text.stripBom(""), "", "empty input stays empty");
	assert.deepEqual(plain(text.splitBom(`${BOM}text`)), { bom: BOM, text: "text" });
	assert.deepEqual(plain(text.splitBom("text")), { bom: "", text: "text" });

	const dir = freshDir("plain-legacy-files");
	const oauthPath = join(dir, "oauth.json");
	const settingsPath = join(dir, "settings.json");
	writeFileSync(oauthPath, JSON.stringify({ github: OAUTH_CREDENTIAL }));
	writeFileSync(
		settingsPath,
		JSON.stringify({ apiKeys: { groq: "sk-groq" }, theme: "light", label: `keep${BOM}me` }),
	);

	const migrations = await loadMigrations(dir);
	assert.deepEqual(plain(migrations.migrateAuthToAuthJson()), ["github", "groq"], "BOM-free input still migrates");

	const auth = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"));
	assert.deepEqual(auth.github, { ...OAUTH_CREDENTIAL, type: "oauth" });
	assert.deepEqual(auth.groq, { type: "api_key", key: "sk-groq" });
	const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
	assert.equal(settings.theme, "light");
	assert.equal(settings.label, `keep${BOM}me`);
	assert.equal(Object.hasOwn(settings, "apiKeys"), false);
	assert.equal(existsSync(oauthPath), false);
	assert.equal(existsSync(`${oauthPath}.migrated`), true);
}

// ---------------------------------------------------------------------------
// 3. Malformed oauth.json is left untouched while usable settings keys migrate.
// ---------------------------------------------------------------------------
{
	const dir = freshDir("malformed-oauth");
	const oauthPath = join(dir, "oauth.json");
	const settingsPath = join(dir, "settings.json");
	const oauthText = `${BOM}{ "anthropic": `;
	writeFileSync(oauthPath, oauthText);
	writeFileSync(settingsPath, JSON.stringify({ apiKeys: { groq: "sk-groq" }, theme: "light" }));

	const migrations = await loadMigrations(dir);
	assert.deepEqual(plain(migrations.migrateAuthToAuthJson()), ["groq"], "malformed oauth.json must not block API keys");

	const auth = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"));
	assert.deepEqual(auth, { groq: { type: "api_key", key: "sk-groq" } });
	assert.equal(readFileSync(oauthPath, "utf8"), oauthText, "malformed oauth.json content must stay untouched");
	assert.equal(existsSync(`${oauthPath}.migrated`), false, "malformed OAuth input must not be archived");
}

// ---------------------------------------------------------------------------
// 4. Malformed settings.json is left untouched while OAuth credentials migrate.
// ---------------------------------------------------------------------------
{
	const dir = freshDir("malformed-settings");
	const oauthPath = join(dir, "oauth.json");
	const settingsPath = join(dir, "settings.json");
	const settingsText = `${BOM}{ "apiKeys": { "groq": "sk-groq" `;
	writeFileSync(oauthPath, `${BOM}${JSON.stringify({ github: OAUTH_CREDENTIAL })}`);
	writeFileSync(settingsPath, settingsText);

	const migrations = await loadMigrations(dir);
	assert.deepEqual(plain(migrations.migrateAuthToAuthJson()), ["github"], "malformed settings.json must not block OAuth");

	const auth = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"));
	assert.deepEqual(auth, { github: { ...OAUTH_CREDENTIAL, type: "oauth" } });
	assert.equal(readFileSync(settingsPath, "utf8"), settingsText, "malformed settings.json must stay untouched");
	assert.equal(existsSync(`${oauthPath}.migrated`), true, "successful OAuth input is still archived");
}

// ---------------------------------------------------------------------------
// 5. Unusable legacy input (broken JSON, non-object JSON) migrates nothing and
//    creates no auth.json, leaving every file byte-identical.
// ---------------------------------------------------------------------------
{
	const dir = freshDir("unusable-input");
	const oauthPath = join(dir, "oauth.json");
	const settingsPath = join(dir, "settings.json");
	const oauthText = "[1, 2, 3]";
	const settingsText = `${BOM}"just-a-string"`;
	writeFileSync(oauthPath, oauthText);
	writeFileSync(settingsPath, settingsText);

	const migrations = await loadMigrations(dir);
	assert.deepEqual(plain(migrations.migrateAuthToAuthJson()), [], "non-object legacy data must not migrate providers");
	assert.equal(existsSync(join(dir, "auth.json")), false, "unusable legacy data must not create auth.json");
	assert.equal(readFileSync(oauthPath, "utf8"), oauthText, "non-object oauth.json must stay untouched");
	assert.equal(readFileSync(settingsPath, "utf8"), settingsText, "non-object settings.json must stay untouched");
	assert.equal(existsSync(`${oauthPath}.migrated`), false, "non-object oauth.json must not be archived");
}

// ---------------------------------------------------------------------------
// 6. An existing auth.json blocks the whole credential migration.
// ---------------------------------------------------------------------------
{
	const dir = freshDir("existing-auth-json");
	const authPath = join(dir, "auth.json");
	const oauthPath = join(dir, "oauth.json");
	const settingsPath = join(dir, "settings.json");
	const authText = JSON.stringify({ existing: { type: "api_key", key: "sk-existing" } }, null, 2);
	const oauthText = `${BOM}${JSON.stringify({ anthropic: OAUTH_CREDENTIAL })}`;
	const settingsText = `${BOM}${JSON.stringify({ apiKeys: { anthropic: "sk-legacy", openai: "sk-openai" } })}`;
	writeFileSync(authPath, authText);
	writeFileSync(oauthPath, oauthText);
	writeFileSync(settingsPath, settingsText);

	const migrations = await loadMigrations(dir);
	assert.deepEqual(plain(migrations.migrateAuthToAuthJson()), [], "an existing auth.json prevents credential migration");
	assert.equal(readFileSync(authPath, "utf8"), authText, "existing auth.json must not be rewritten");
	assert.equal(readFileSync(oauthPath, "utf8"), oauthText, "oauth.json must not be archived when auth.json exists");
	assert.equal(existsSync(`${oauthPath}.migrated`), false);
	assert.equal(readFileSync(settingsPath, "utf8"), settingsText, "settings.json must not be rewritten");

	const { ReadOnlyAuthStorage } = await loadAuthStorage(dir);
	const storage = new ReadOnlyAuthStorage(authPath);
	assert.deepEqual(await readCredential(storage, "existing"), {
		ok: true,
		value: { type: "api_key", key: "sk-existing" },
	});
	assert.deepEqual(await readCredential(storage, "anthropic"), { ok: true, value: undefined });
}

// ---------------------------------------------------------------------------
// 7. runMigrations reports the migrated providers through its public result.
// ---------------------------------------------------------------------------
{
	const dir = freshDir("run-migrations");
	writeFileSync(join(dir, "oauth.json"), `${BOM}${JSON.stringify({ github: OAUTH_CREDENTIAL })}`);
	writeFileSync(join(dir, "settings.json"), `${BOM}${JSON.stringify({ apiKeys: { github: "sk-github" } })}`);

	const migrations = await loadMigrations(dir);
	const result = migrations.runMigrations(dir);
	assert.deepEqual(plain(result.migratedAuthProviders), ["github"], "OAuth provider is reported once");
	assert.deepEqual(plain(result.deprecationWarnings), [], "no deprecation warnings for a clean directory");

	const auth = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"));
	assert.deepEqual(auth.github, { ...OAUTH_CREDENTIAL, type: "oauth" }, "runMigrations keeps OAuth precedence");
}

console.log("session-integrity regression suite passed (7 scenarios, real text/migrations/auth-storage modules)");
