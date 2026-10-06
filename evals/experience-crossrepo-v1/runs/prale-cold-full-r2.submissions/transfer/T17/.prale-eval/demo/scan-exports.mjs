// Scans packages/coding-agent/src for bare (npm) import specifiers so the demo
// harness can provide offline stubs. This never executes the scanned code.
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../packages/coding-agent/src", import.meta.url).pathname;

const files = [];
(function walk(dir) {
	for (const entry of readdirSync(dir)) {
		const p = join(dir, entry);
		const st = statSync(p);
		if (st.isDirectory()) walk(p);
		else if (entry.endsWith(".ts")) files.push(p);
	}
})(ROOT);

const importRe = /import\s+(?:type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
const sideEffectRe = /import\s+["']([^"']+)["']/g;
const exportRe = /export\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s+["']([^"']+)["']/g;

const map = new Map();
const add = (spec, name) => {
	if (!name || name.startsWith("type ")) return;
	const set = map.get(spec) ?? new Set();
	set.add(name);
	map.set(spec, set);
};

for (const file of files) {
	const src = readFileSync(file, "utf-8");
	for (const m of src.matchAll(importRe)) {
		const [, clause, spec] = m;
		if (spec.startsWith(".") || spec.startsWith("node:") || spec.startsWith("/")) continue;
		const trimmed = clause.trim();
		if (trimmed.startsWith("*")) {
			add(spec, "");
			continue;
		}
		if (trimmed.startsWith("{")) {
			for (const part of trimmed.slice(1, -1).split(",")) {
				const name = part.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, "").trim();
				if (name) add(spec, name);
			}
		} else {
			add(spec, trimmed.replace(/^type\s+/, "").split(",")[0].trim());
			const brace = trimmed.indexOf("{");
			if (brace >= 0) {
				for (const part of trimmed.slice(brace + 1, trimmed.lastIndexOf("}")).split(",")) {
					const name = part.trim().split(/\s+as\s+/)[0].trim();
					if (name) add(spec, name);
				}
			}
		}
	}
	for (const m of src.matchAll(sideEffectRe)) {
		if (!m[1].startsWith(".") && !m[1].startsWith("node:")) add(m[1], "__sideEffect");
	}
	for (const m of src.matchAll(exportRe)) {
		if (!m[2].startsWith(".") && !m[2].startsWith("node:")) add(m[2], "__reexport");
	}
}

const out = {};
for (const [spec, names] of [...map.entries()].sort()) out[spec] = [...names].sort();
writeFileSync(new URL("./stub-exports.json", import.meta.url), `${JSON.stringify(out, null, "\t")}\n`);
console.log(`scanned ${files.length} files; ${Object.keys(out).length} bare specifiers`);
for (const [spec, names] of Object.entries(out)) console.log(`  ${spec}: ${names.length}`);
