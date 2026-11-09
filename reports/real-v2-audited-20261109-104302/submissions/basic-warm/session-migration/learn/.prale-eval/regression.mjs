/**
 * Standalone Node assertion regression for the legacy auth migration.
 *
 * Exercises the real `migrateAuthToAuthJson` implementation from
 * packages/coding-agent/src/migrations.ts (loaded through ./subject.mjs, which
 * only fakes the `getAgentDir` / `stripBom` import boundaries and uses the real
 * fs and path modules against a temporary agent directory).
 *
 * Run from the workspace root:
 *   node --experimental-vm-modules .prale-eval/regression.mjs
 *
 * Exits 0 only when every assertion holds. Any violated expectation throws an
 * AssertionError and the process exits non-zero.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { loadMigrations } from "./subject.mjs";

const root = path.resolve(import.meta.dirname, "..");
const BOM = "\uFEFF";

const readText = (file) => readFileSync(file, "utf8");
const json = (file) => JSON.parse(readText(file));

/** Temporary root; prefer the workspace, fall back to the OS temp dir. */
function makeTempRoot() {
	for (const base of [root, tmpdir()]) {
		try {
			return mkdtempSync(path.join(base, ".prale-regression-"));
		} catch {
			// try the next writable base
		}
	}
	throw new Error("Unable to create a temporary directory for the regression");
}

const tempRoot = makeTempRoot();
let caseIndex = 0;
const checks = [];

/** Fresh agent directory plus freshly loaded real migration module for it. */
async function scenario({ oauth, settings, auth }) {
	const agentDir = path.join(tempRoot, `case-${++caseIndex}`);
	const migrations = await loadMigrations(root, agentDir);
	const prepare = (name, content) => {
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(path.join(agentDir, name), content, "utf8");
	};
	if (oauth !== undefined) prepare("oauth.json", oauth);
	if (settings !== undefined) prepare("settings.json", settings);
	if (auth !== undefined) prepare("auth.json", auth);
	const paths = {
		oauth: path.join(agentDir, "oauth.json"),
		oauthMigrated: path.join(agentDir, "oauth.json.migrated"),
		settings: path.join(agentDir, "settings.json"),
		auth: path.join(agentDir, "auth.json"),
	};
	// The module lives in a separate VM realm, so copy the returned array into
	// this realm to keep strict deep-equality comparisons meaningful.
	const run = () => Array.from(migrations.migrateAuthToAuthJson());
	return { agentDir, paths, run };
}

function ok(label) {
	checks.push(label);
}

async function main() {
	// ---------------------------------------------------------------------
	// 1. Legacy oauth.json written with a UTF-8 BOM must still migrate.
	//    This is the stage's original fault: the BOM made JSON.parse throw,
	//    the catch swallowed it, and the OAuth credentials were silently lost.
	// ---------------------------------------------------------------------
	{
		const oauthDoc = {
			anthropic: { access: "ant-access-token", refresh: "ant-refresh-token", expires: 1_700_000_000_000 },
			"github-copilot": { access: "gh-access", refresh: "gh-refresh" },
		};
		const oauthText = BOM + JSON.stringify(oauthDoc, null, 2);
		const { paths, run } = await scenario({ oauth: oauthText });

		const providers = run();

		assert.deepEqual(
			providers,
			["anthropic", "github-copilot"],
			"BOM-prefixed oauth.json must migrate every OAuth provider",
		);
		assert.equal(existsSync(paths.auth), true, "auth.json must be created for BOM-prefixed oauth.json");
		assert.deepEqual(
			json(paths.auth),
			{
				anthropic: { type: "oauth", ...oauthDoc.anthropic },
				"github-copilot": { type: "oauth", ...oauthDoc["github-copilot"] },
			},
			"OAuth credentials from a BOM-prefixed oauth.json must be preserved verbatim with type=oauth",
		);
		assert.equal(existsSync(paths.oauth), false, "migrated oauth.json is archived");
		assert.deepEqual(
			JSON.parse(readText(paths.oauthMigrated).replace(/^\uFEFF/, "")),
			oauthDoc,
			"archived oauth.json.migrated keeps the original credentials",
		);
		ok("BOM-prefixed oauth.json migrates and preserves OAuth credentials");
	}

	// ---------------------------------------------------------------------
	// 2. OAuth precedence over API keys, with API-key fallback for providers
	//    that only exist in settings.json.
	// ---------------------------------------------------------------------
	{
		const oauthDoc = { anthropic: { access: "ant-access", refresh: "ant-refresh" }, openai: { access: "oa", refresh: "or" } };
		const { paths, run } = await scenario({
			oauth: BOM + JSON.stringify(oauthDoc, null, 2),
			settings: JSON.stringify(
				{ theme: "dark", apiKeys: { anthropic: "sk-ant-legacy", google: "g-key", "github-copilot": 42 } },
				null,
				2,
			),
		});

		const providers = run();

		assert.deepEqual(
			providers,
			["anthropic", "openai", "google"],
			"oauth providers first, then API-key-only providers; non-string keys and OAuth-shadowed keys are skipped",
		);
		const auth = json(paths.auth);
		assert.deepEqual(auth.anthropic, { type: "oauth", ...oauthDoc.anthropic }, "OAuth must take precedence over apiKeys");
		assert.deepEqual(auth.openai, { type: "oauth", ...oauthDoc.openai }, "OAuth providers keep type=oauth");
		assert.deepEqual(auth.google, { type: "api_key", key: "g-key" }, "API-key fallback still migrates");
		assert.equal(auth["github-copilot"], undefined, "non-string apiKeys are not migrated");
		const settingsAfter = json(paths.settings);
		assert.equal("apiKeys" in settingsAfter, false, "apiKeys are removed from settings.json once migrated");
		assert.equal(settingsAfter.theme, "dark", "unrelated settings survive the migration");
		ok("OAuth precedence and API-key fallback both hold");
	}

	// ---------------------------------------------------------------------
	// 3. Malformed oauth.json must not be destroyed (with and without a BOM),
	//    and its failure must not block the apiKeys fallback.
	// ---------------------------------------------------------------------
	{
		const brokenWithBom = `${BOM}{"anthropic": {"access": "ant-access"`;
		const { paths, run } = await scenario({
			oauth: brokenWithBom,
			settings: JSON.stringify({ apiKeys: { openai: "sk-openai-legacy" } }, null, 2),
		});

		const providers = run();

		assert.deepEqual(providers, ["openai"], "malformed oauth.json is skipped but apiKeys still migrate");
		assert.equal(existsSync(paths.oauth), true, "malformed oauth.json must not be renamed or deleted");
		assert.equal(readText(paths.oauth), brokenWithBom, "malformed oauth.json bytes must be untouched");
		assert.equal(existsSync(paths.oauthMigrated), false, "malformed oauth.json is not archived as migrated");
		assert.deepEqual(json(paths.auth), { openai: { type: "api_key", key: "sk-openai-legacy" } });
		ok("malformed BOM oauth.json is preserved and does not block apiKeys");
	}
	{
		const broken = '{"anthropic": {"access": "ant-access"';
		const { paths, run } = await scenario({ oauth: broken });

		const providers = run();

		assert.deepEqual(providers, [], "malformed oauth.json with no other source migrates nothing");
		assert.equal(existsSync(paths.auth), false, "no auth.json is written when nothing was migrated");
		assert.equal(existsSync(paths.oauth), true, "malformed oauth.json must not be renamed or deleted");
		assert.equal(readText(paths.oauth), broken, "malformed oauth.json bytes must be untouched");
		ok("malformed oauth.json without BOM is preserved");
	}

	// ---------------------------------------------------------------------
	// 4. An existing auth.json stays untouched and short-circuits migration.
	// ---------------------------------------------------------------------
	{
		const existingAuth = '{ "anthropic": { "type": "api_key", "key": "already-set" } }\n';
		const oauthDoc = { anthropic: { access: "ant-access", refresh: "ant-refresh" } };
		const settingsText = JSON.stringify({ apiKeys: { openai: "sk-openai" } }, null, 2);
		const { paths, run } = await scenario({
			oauth: BOM + JSON.stringify(oauthDoc, null, 2),
			settings: settingsText,
			auth: existingAuth,
		});

		const providers = run();

		assert.deepEqual(providers, [], "migration is skipped when auth.json already exists");
		assert.equal(readText(paths.auth), existingAuth, "existing auth.json bytes must be untouched");
		assert.equal(existsSync(paths.oauth), true, "oauth.json is left in place when auth.json already exists");
		assert.equal(readText(paths.settings), settingsText, "settings.json is untouched when auth.json already exists");
		ok("existing auth.json remains untouched");
	}

	// ---------------------------------------------------------------------
	// 5. Non-BOM oauth.json keeps working (no regression in the plain path).
	// ---------------------------------------------------------------------
	{
		const oauthDoc = { anthropic: { access: "a", refresh: "r" } };
		const { paths, run } = await scenario({ oauth: JSON.stringify(oauthDoc) });

		const providers = run();

		assert.deepEqual(providers, ["anthropic"], "plain oauth.json still migrates");
		assert.deepEqual(json(paths.auth), { anthropic: { type: "oauth", ...oauthDoc.anthropic } });
		ok("plain oauth.json still migrates");
	}

	assert.equal(checks.length, 6, "all regression scenarios ran");
}

try {
	await main();
	console.log(`regression: ${checks.length} scenario checks passed`);
} finally {
	rmSync(tempRoot, { recursive: true, force: true });
}
