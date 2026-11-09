/**
 * Cross-module regression for legacy credential migration.
 *
 * Loads the submitted `utils/text.ts` and `migrations.ts` through the real
 * module graph in `subject.mjs` (only fs/config boundaries are synthesized),
 * then asserts observable behaviour across the text -> migration boundary:
 * leading-BOM removal only, interior/plain text preservation, OAuth precedence
 * over same-provider settings API keys, retention of unrelated settings,
 * archiving of successfully migrated OAuth input, untouched malformed input,
 * and no migration at all when auth.json already exists.
 *
 * Node 24: `node --experimental-vm-modules .prale-eval/regression.mjs`
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { createSessionPipeline } from "./subject.mjs";

const workspace = path.resolve(import.meta.dirname, "..");
const sandbox = path.join(workspace, ".prale-eval", ".regression-tmp");
const BOM = "\uFEFF";

/** Values cross the vm realm boundary, so normalize before deep comparison. */
const plain = (value) => JSON.parse(JSON.stringify(value));
const read = (file) => fs.readFileSync(file, "utf8");
const agentDirFor = (name) => {
	const dir = path.join(sandbox, name);
	fs.rmSync(dir, { recursive: true, force: true });
	fs.mkdirSync(dir, { recursive: true });
	return dir;
};

async function pipelineFor(agentDir) {
	return await createSessionPipeline(workspace, agentDir);
}

async function textDecoding() {
	const agentDir = agentDirFor("text-decoding");
	const { text } = await pipelineFor(agentDir);

	// Plain text is untouched.
	assert.equal(text.stripBom("plain text"), "plain text", "plain text must be preserved");
	assert.equal(text.stripBom(""), "", "empty text must be preserved");

	// Exactly one leading BOM is removed.
	assert.equal(text.stripBom(`${BOM}plain text`), "plain text", "leading BOM must be removed");
	assert.equal(text.stripBom(`${BOM}${BOM}double`), `${BOM}double`, "only one leading BOM may be removed");

	// BOMs that are not leading are content, not encoding markers.
	assert.equal(text.stripBom(`interior${BOM}bom`), `interior${BOM}bom`, "interior BOM must be preserved");
	assert.equal(text.stripBom(`trailing${BOM}`), `trailing${BOM}`, "trailing BOM must be preserved");
	assert.equal(text.stripBom(`text ${BOM} mid`), `text ${BOM} mid`, "embedded BOM must be preserved");

	// splitBom keeps its public contract while stripBom is built on the same rule.
	assert.deepEqual(plain(text.splitBom(`${BOM}content`)), { bom: BOM, text: "content" });
	assert.deepEqual(plain(text.splitBom("content")), { bom: "", text: "content" });
	assert.deepEqual(plain(text.splitBom(`content${BOM}`)), { bom: "", text: `content${BOM}` });
}

async function bomEncodedMigration() {
	const agentDir = agentDirFor("bom-encoded");
	const oauthSource = `${BOM}${JSON.stringify({
		anthropic: { access: "oauth-anthropic", refresh: "refresh-anthropic", expires: 4102444800000 },
		openai: { access: `oauth${BOM}openai` },
	})}`;
	const settingsSource = `${BOM}${JSON.stringify({
		apiKeys: { anthropic: "settings-anthropic-key", google: `api${BOM}google` },
		theme: "dark",
		defaultModel: "kept-model",
		compaction: { reserveTokens: 8192, keepRecentTokens: 2000 },
	})}`;
	const oauthPath = path.join(agentDir, "oauth.json");
	const settingsPath = path.join(agentDir, "settings.json");
	const authPath = path.join(agentDir, "auth.json");
	fs.writeFileSync(oauthPath, oauthSource, "utf8");
	fs.writeFileSync(settingsPath, settingsSource, "utf8");

	const { migration } = await pipelineFor(agentDir);
	const providers = migration.migrateAuthToAuthJson();

	// OAuth is migrated first; the same-provider settings key must not overwrite it.
	assert.deepEqual([...providers], ["anthropic", "openai", "google"], "OAuth providers must precede new API-key providers");

	const auth = JSON.parse(read(authPath));
	assert.equal(auth.anthropic.type, "oauth", "OAuth credential must win over same-provider settings API key");
	assert.equal(auth.anthropic.access, "oauth-anthropic");
	assert.equal(auth.anthropic.refresh, "refresh-anthropic");
	assert.equal(auth.anthropic.key, undefined, "settings API key must not leak into the OAuth credential");
	// Interior BOM in OAuth text survives decoding.
	assert.equal(auth.openai.type, "oauth");
	assert.equal(auth.openai.access, `oauth${BOM}openai`, "interior BOM must survive OAuth decoding");
	// Providers only present in settings still migrate as API keys, BOM-free.
	assert.deepEqual(auth.google, { type: "api_key", key: `api${BOM}google` });

	// Unrelated settings are retained; only apiKeys is consumed.
	const settings = JSON.parse(read(settingsPath));
	assert.equal(settings.apiKeys, undefined, "apiKeys must be removed once migrated");
	assert.equal(settings.theme, "dark", "unrelated setting must be retained");
	assert.equal(settings.defaultModel, "kept-model", "unrelated setting must be retained");
	assert.deepEqual(settings.compaction, { reserveTokens: 8192, keepRecentTokens: 2000 });

	// Successfully migrated OAuth input is archived byte-for-byte and removed.
	assert.equal(fs.existsSync(oauthPath), false, "migrated oauth.json must be moved away");
	assert.equal(read(`${oauthPath}.migrated`), oauthSource, "archived OAuth input must keep its original bytes");
}

async function malformedOAuthInput() {
	const agentDir = agentDirFor("malformed-oauth");
	const oauthSource = `${BOM}{"anthropic": {"access": `;
	const settingsSource = JSON.stringify({ apiKeys: { google: "api-google" }, theme: "light" });
	const oauthPath = path.join(agentDir, "oauth.json");
	const settingsPath = path.join(agentDir, "settings.json");
	fs.writeFileSync(oauthPath, oauthSource, "utf8");
	fs.writeFileSync(settingsPath, settingsSource, "utf8");

	const { migration } = await pipelineFor(agentDir);
	const providers = migration.migrateAuthToAuthJson();

	assert.deepEqual([...providers], ["google"], "settings API keys still migrate when OAuth input is malformed");
	const auth = JSON.parse(read(path.join(agentDir, "auth.json")));
	assert.deepEqual(auth, { google: { type: "api_key", key: "api-google" } });
	// Malformed data is left exactly where it was, unarchived.
	assert.equal(fs.existsSync(oauthPath), true, "malformed oauth.json must not be removed");
	assert.equal(fs.existsSync(`${oauthPath}.migrated`), false, "malformed oauth.json must not be archived");
	assert.equal(read(oauthPath), oauthSource, "malformed oauth.json must keep its original bytes");
}

async function malformedSettingsInput() {
	const agentDir = agentDirFor("malformed-settings");
	const oauthSource = JSON.stringify({ anthropic: { access: "oauth-anthropic" } });
	const settingsSource = `${BOM}{"apiKeys": {"google": "unterminated"`;
	const oauthPath = path.join(agentDir, "oauth.json");
	const settingsPath = path.join(agentDir, "settings.json");
	fs.writeFileSync(oauthPath, oauthSource, "utf8");
	fs.writeFileSync(settingsPath, settingsSource, "utf8");

	const { migration } = await pipelineFor(agentDir);
	const providers = migration.migrateAuthToAuthJson();

	assert.deepEqual([...providers], ["anthropic"], "OAuth still migrates when settings input is malformed");
	const auth = JSON.parse(read(path.join(agentDir, "auth.json")));
	assert.equal(auth.anthropic.type, "oauth");
	assert.equal(read(settingsPath), settingsSource, "malformed settings.json must keep its original bytes");
	assert.equal(read(`${oauthPath}.migrated`), oauthSource, "valid OAuth input is still archived");
}

async function existingAuthFileBlocksMigration() {
	const agentDir = agentDirFor("existing-auth");
	const authSource = `${JSON.stringify({ github: { type: "api_key", key: "existing-token" } })}\n`;
	const oauthSource = JSON.stringify({ anthropic: { access: "oauth-anthropic" } });
	const settingsSource = JSON.stringify({ apiKeys: { google: "api-google" }, theme: "dark" });
	const authPath = path.join(agentDir, "auth.json");
	const oauthPath = path.join(agentDir, "oauth.json");
	const settingsPath = path.join(agentDir, "settings.json");
	fs.writeFileSync(authPath, authSource, "utf8");
	fs.writeFileSync(oauthPath, oauthSource, "utf8");
	fs.writeFileSync(settingsPath, settingsSource, "utf8");

	const { migration } = await pipelineFor(agentDir);
	const providers = migration.migrateAuthToAuthJson();

	assert.deepEqual([...providers], [], "an existing auth.json must block all credential migration");
	assert.equal(read(authPath), authSource, "existing auth.json must not be rewritten");
	assert.equal(read(oauthPath), oauthSource, "oauth.json must not be consumed when auth.json exists");
	assert.equal(fs.existsSync(`${oauthPath}.migrated`), false, "oauth.json must not be archived when auth.json exists");
	assert.equal(read(settingsPath), settingsSource, "settings.json must not be rewritten when auth.json exists");
}

async function plainCredentialMigration() {
	const agentDir = agentDirFor("plain-credentials");
	const settingsSource = JSON.stringify({ apiKeys: { google: "api-google", openai: "api-openai" }, theme: "solarized" });
	const settingsPath = path.join(agentDir, "settings.json");
	fs.writeFileSync(settingsPath, settingsSource, "utf8");

	const { migration } = await pipelineFor(agentDir);
	const providers = migration.migrateAuthToAuthJson();

	assert.deepEqual([...providers], ["google", "openai"]);
	const auth = JSON.parse(read(path.join(agentDir, "auth.json")));
	assert.deepEqual(auth, {
		google: { type: "api_key", key: "api-google" },
		openai: { type: "api_key", key: "api-openai" },
	});
	const settings = JSON.parse(read(settingsPath));
	assert.equal(settings.apiKeys, undefined);
	assert.equal(settings.theme, "solarized", "unrelated settings survive a plain (BOM-free) migration");
}

async function main() {
	fs.rmSync(sandbox, { recursive: true, force: true });
	try {
		// Ordered steps; every assertion is synchronous and deterministic.
		const steps = [
			textDecoding,
			bomEncodedMigration,
			malformedOAuthInput,
			malformedSettingsInput,
			existingAuthFileBlocksMigration,
			plainCredentialMigration,
		];
		for (const step of steps) {
			await step();
			await Promise.resolve();
		}
		console.log("credential migration regression: passed");
	} finally {
		fs.rmSync(sandbox, { recursive: true, force: true });
	}
}

await main();
