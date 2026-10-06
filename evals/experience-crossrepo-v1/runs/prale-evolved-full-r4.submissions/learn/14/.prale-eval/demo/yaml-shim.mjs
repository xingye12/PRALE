/**
 * yaml-shim.mjs — minimal stand-in for the repository's `yaml` dependency.
 *
 * The workspace checkout has no `node_modules`, so the real `yaml` package used by
 * `MemoryKnowledge/src/engines/wiki/ingest-v2/frontmatter.ts` is unavailable and no
 * dependencies may be installed. This shim implements only the YAML subset that the
 * demo corpus and `buildPage()` exercise:
 *   - flat `key: value` scalars (string / number / boolean / null)
 *   - flow sequences `key: [a, b]` and block sequences (`- item` lines)
 *   - single/double quoted scalars
 * It is wired in place of `yaml` by ./loader.mjs. Any YAML feature outside this
 * subset is out of scope and is reported as a validation limitation.
 */

function parseScalar(raw) {
  const v = raw.trim();
  if (v === "") return "";
  if (v === "null" || v === "~") return null;
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^[+-]?\d+$/.test(v)) return Number.parseInt(v, 10);
  if (/^[+-]?\d*\.\d+$/.test(v)) return Number.parseFloat(v);
  if (/^".*"$/.test(v) || /^'.*'$/.test(v)) return v.slice(1, -1);
  return v;
}

export function parse(text) {
  const out = {};
  const lines = String(text ?? "").split(/\r?\n/);
  let currentKey = null;
  for (const line of lines) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const listItem = /^\s*-\s*(.*)$/.exec(line);
    if (listItem && currentKey !== null) {
      const arr = Array.isArray(out[currentKey]) ? out[currentKey] : [];
      arr.push(parseScalar(listItem[1]));
      out[currentKey] = arr;
      continue;
    }
    const kv = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    const rest = kv[2].trim();
    if (rest === "") {
      // Value may be a following block sequence (or empty).
      out[key] = null;
      currentKey = key;
      continue;
    }
    currentKey = null;
    if (/^\[.*\]$/.test(rest)) {
      out[key] = rest
        .slice(1, -1)
        .split(",")
        .map((s) => parseScalar(s))
        .filter((s) => s !== "");
      continue;
    }
    out[key] = parseScalar(rest);
  }
  // Drop placeholder nulls that were followed by a block sequence.
  return out;
}

export function stringify(value) {
  const obj = value ?? {};
  const lines = [];
  for (const [key, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      if (v.length === 0) {
        lines.push(`${key}: []`);
        continue;
      }
      lines.push(`${key}:`);
      for (const item of v) lines.push(`  - ${format(item)}`);
      continue;
    }
    lines.push(`${key}: ${format(v)}`);
  }
  return lines.join("\n") + "\n";
}

function format(v) {
  if (v === null) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = String(v);
  return /[:#[\]{},&*!|>'"%@`]|^\s|\s$/.test(s) ? JSON.stringify(s) : s;
}
