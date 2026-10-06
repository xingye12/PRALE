/**
 * yaml-shim.mjs — TEST DOUBLE for the `yaml` npm package.
 *
 * WHY THIS EXISTS
 * ---------------
 * `MemoryKnowledge/src/engines/wiki/ingest-v2/frontmatter.ts` imports
 * `parse`/`stringify` from the third-party `yaml` package. That package is NOT
 * installed in this evaluation environment (`node_modules` is absent) and the
 * task forbids installing dependencies. So that the REAL `parseFrontmatter` /
 * `buildPage` code can be executed unmodified, `register.mjs` maps the bare
 * specifier "yaml" to this module via a Node module-resolution hook.
 *
 * SCOPE / LIMITS
 * --------------
 * This is a deliberately strict, minimal YAML subset parser covering exactly
 * the flat `key: scalar` / `key: [flow, list]` frontmatter maps used by the
 * corpus in this demo. It is intentionally NOT a general YAML implementation:
 * nested maps, block scalars, anchors and multi-document streams are not
 * supported and are rejected by throwing — mirroring how the real `yaml`
 * package throws on malformed frontmatter, which is the behaviour
 * `parseFrontmatter` guards with try/catch.
 *
 * It is scaffolding for the demo only; it is never imported by repository code.
 */

const KEY_RE = /^([A-Za-z0-9_.-]+):(?:[ \t]+(.*))?$/;

function parseScalar(raw) {
  const v = raw.trim();
  if (v === "") return null;
  if (v.startsWith("[")) {
    if (!v.endsWith("]")) throw new Error(`unterminated flow sequence: ${raw}`);
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((p) => parseScalar(p));
  }
  if (v.startsWith('"') || v.startsWith("'")) {
    const q = v[0];
    if (v.length < 2 || !v.endsWith(q)) throw new Error(`unterminated quoted scalar: ${raw}`);
    return v.slice(1, -1);
  }
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

export function parse(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (/^[ \t]/.test(line)) throw new Error(`unexpected indentation (nested YAML unsupported): ${line}`);
    const m = KEY_RE.exec(line);
    if (!m) throw new Error(`not a flat "key: value" mapping: ${line}`);
    out[m[1]] = parseScalar(m[2] ?? "");
  }
  return out;
}

export function stringify(value) {
  const lines = [];
  for (const [k, v] of Object.entries(value ?? {})) {
    if (Array.isArray(v)) lines.push(`${k}: [${v.map((x) => String(x)).join(", ")}]`);
    else if (v === null || v === undefined) lines.push(`${k}:`);
    else lines.push(`${k}: ${String(v)}`);
  }
  return lines.join("\n");
}

export default { parse, stringify };
