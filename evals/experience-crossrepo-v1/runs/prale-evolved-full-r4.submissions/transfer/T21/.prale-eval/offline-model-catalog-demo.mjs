#!/usr/bin/env node
// T21 offline operate demo.
//
// Builds a JSON-only model-catalog fixture *inside the workspace* and validates
// it with scripts/publish-model-catalog.mjs --dry-run. The fixture contains no
// network data (models.dev / provider /models payloads) and the dry-run path
// returns before any `aws s3` or `git` child process is spawned, so the check
// is fully offline-safe.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const input = join(root, ".prale-eval", "fixture", "model-catalog");
rmSync(input, { recursive: true, force: true });
const providersDir = join(input, "providers");
mkdirSync(providersDir, { recursive: true });

const chat = (provider, index) => ({ type: "chat", id: `${provider}-chat-${index}`, provider });
const allModels = {
	anthropic: Array.from({ length: 500 }, (_, index) => chat("anthropic", index)),
	openai: Array.from({ length: 5 }, (_, index) => chat("openai", index)),
	openrouter: [
		chat("openrouter", 0),
		{ type: "image", id: "openrouter-image-0", provider: "openrouter" },
		{ type: "classifier", id: "openrouter-classifier-0", provider: "openrouter" },
	],
};
const chatProjection = (list) =>
	Object.fromEntries(list.filter((model) => model.type === "chat").map((model) => [model.id, model]));
const models = Object.fromEntries(Object.entries(allModels).map(([provider, list]) => [provider, chatProjection(list)]));
const providerIds = Object.keys(allModels).sort();
const writeJson = (path, value) => writeFileSync(path, `${JSON.stringify(value)}\n`);

writeJson(join(input, "models.json"), models);
writeJson(join(input, "models.all.json"), allModels);
writeJson(join(input, "providers.json"), providerIds);
for (const provider of providerIds) {
	writeJson(join(providersDir, `${provider}.json`), models[provider]);
	writeJson(join(providersDir, `${provider}.all.json`), allModels[provider]);
}

const result = spawnSync(
	process.execPath,
	[
		"scripts/publish-model-catalog.mjs",
		"--input",
		input,
		"--source-commit",
		"t21-offline-fixture",
		"--dry-run",
	],
	{ cwd: root, encoding: "utf8" },
);
assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
assert.match(result.stdout, /no objects uploaded/);

const publication = JSON.parse(readFileSync(join(input, "publication.json"), "utf8"));
assert.equal(publication.chatModelCount, 506);
assert.equal(publication.imageModelCount, 1);
assert.equal(publication.classifierModelCount, 1);
assert.equal(publication.totalModelCount, 508);
console.log(JSON.stringify(publication, null, 2));
