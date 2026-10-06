#!/usr/bin/env node
/**
 * normalize-ingest-demo.mjs — executable demo for cross-repo task learn/27 (repo `tdam`).
 *
 * Request: "normalize markdown/frontmatter input before indexing and reject malformed metadata."
 *
 * What it demonstrates
 * --------------------
 * A pre-indexing normalization gate for wiki pages that combines the two
 * behaviours already present in TencentDB Agent Memory:
 *
 *   1. Canonical-form normalization, modelled on
 *      `MemoryKnowledge/src/engines/code/normalize.ts` (`normalizeRepoUrl`):
 *      many spellings collapse to one canonical string, and the transform is
 *      idempotent (normalizing an already-normalized value is a pass-through).
 *
 *   2. Tolerant parse / strict gate, modelled on
 *      `MemoryKnowledge/src/engines/wiki/ingest-v2/frontmatter.ts`
 *      (`parseFrontmatter` + `buildPage`): the parser never throws, but the
 *      indexing gate rejects documents whose metadata is malformed instead of
 *      silently indexing them under the placeholder `type: "other"`.
 *
 * Pipeline per document:
 *   raw markdown -> structural normalize -> frontmatter split -> metadata
 *   validation (accept | reject) -> canonical re-serialization (buildPage) ->
 *   index entry (title/path/type/description/sources) -> rendered index.md.
 *
 * The demo prints a per-document report, asserts the expected outcome of every
 * case, writes the normalized operation result to
 * `.prale-eval/demo/output/demo-run.json`, and exits non-zero if any assertion
 * fails.
 *
 * Runtime notes / limitations
 * ---------------------------
 * - The real `normalize.ts` module is imported and executed directly (Node 24
 *   strips TypeScript types at load time). No transpiler, no install step.
 * - The real `frontmatter.ts` module cannot be imported in this checkout: its
 *   `yaml` dependency is not installed (`node_modules/` is absent), so the
 *   import fails with ERR_MODULE_NOT_FOUND. The demo catches exactly that error
 *   and falls back to a dependency-free adapter that reproduces the exported
 *   contract (FM_RE, tolerant `parseFrontmatter`, fixed-order `buildPage`).
 *   The fallback is reported in the run result and must not be mistaken for the
 *   repo module. When the module *is* importable it is used for body splitting
 *   and page building; the demo additionally needs a raw, pre-coercion view of
 *   the mapping, which the repo module does not expose, so that one helper
 *   always comes from the adapter.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// --- Real repo symbols: canonicalization + unique source key ----------------
import { normalizeRepoUrl, sourceKey, parseSourceKey } from "../../MemoryKnowledge/src/engines/code/normalize.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "output");
const OUT_FILE = join(OUT_DIR, "demo-run.json");

// ---------------------------------------------------------------------------
// frontmatter adapter: prefer the repo module, fall back when `yaml` is absent
// ---------------------------------------------------------------------------

// == frontmatter.ts:36
const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

let frontmatterSource;
let repoParseFrontmatter = null;
let repoBuildPage = null;

try {
  const mod = await import("../../MemoryKnowledge/src/engines/wiki/ingest-v2/frontmatter.ts");
  repoParseFrontmatter = mod.parseFrontmatter;
  repoBuildPage = mod.buildPage;
  frontmatterSource = "MemoryKnowledge/src/engines/wiki/ingest-v2/frontmatter.ts (repo module)";
} catch (err) {
  if (err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
  frontmatterSource =
    "dependency-free adapter mirroring frontmatter.ts contract " +
    "(repo module unimportable: package 'yaml' not installed)";
}

/**
 * Raw (pre-coercion) frontmatter view used by the validation gate.
 *
 * `parseFrontmatter` deliberately coerces a missing/invalid `type` to "other"
 * (frontmatter.ts:60), which is right for tolerant consumption but destroys the
 * evidence the gate needs. So the gate re-reads the YAML block before that
 * coercion; this is the difference between "index under a placeholder" and
 * "reject the page".
 */
function parseRawBlock(yamlText) {
  const obj = {};
  const lines = yamlText.split("\n");
  let sawMapping = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (/^\s/.test(line)) return { ok: false, reason: "unexpected indentation" };
    const m = line.match(/^([A-Za-z0-9_.-]+):(?:\s*(.*))?$/);
    if (!m) {
      // A bare scalar is a valid YAML document that is not a mapping.
      if (!sawMapping && lines.filter((l) => l.trim() && !/^\s*#/.test(l)).length === 1)
        return { ok: true, value: line.trim() };
      return { ok: false, reason: `unparsable line: ${JSON.stringify(line)}` };
    }
    sawMapping = true;
    const key = m[1];
    const val = (m[2] ?? "").trim();
    if (val === "") {
      const items = [];
      while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
        i++;
        items.push(unquote(lines[i].replace(/^\s*-\s+/, "").trim()));
      }
      obj[key] = items;
      continue;
    }
    if (val.startsWith("[")) {
      if (!val.endsWith("]")) return { ok: false, reason: "unterminated flow sequence" };
      obj[key] = val.slice(1, -1).split(",").map((s) => unquote(s.trim())).filter((s) => s !== "");
      continue;
    }
    if (val.startsWith('"') || val.startsWith("'")) {
      if (val.length < 2 || !val.endsWith(val[0])) return { ok: false, reason: "unterminated quoted scalar" };
      obj[key] = val.slice(1, -1);
      continue;
    }
    obj[key] = val === "true" ? true : val === "false" ? false : val;
  }
  return { ok: true, value: obj };
}

const unquote = (s) =>
  (s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")) ? s.slice(1, -1) : s;

/** Mirrors frontmatter.ts: same FM_RE, tolerant parse, type coercion to "other". */
function adapterParseFrontmatter(content) {
  const text = content ?? "";
  const m = text.match(FM_RE);
  if (!m) return { frontmatter: { type: "other" }, body: text, hasFrontmatter: false };
  const body = text.slice(m[0].length);
  const parsed = parseRawBlock(m[1]);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") {
    return { frontmatter: { type: "other" }, body, hasFrontmatter: false };
  }
  const fm = parsed.value;
  const type = typeof fm.type === "string" && fm.type.trim() ? fm.type : "other";
  return { frontmatter: { ...fm, type }, body, hasFrontmatter: true };
}

/** Quote only when YAML would otherwise re-read the scalar as something else. */
function scalar(v) {
  const s = String(v);
  const plain = /^[A-Za-z0-9_][A-Za-z0-9_./@-]*$/.test(s) && !/^(true|false|null|~)$/i.test(s);
  return plain ? s : JSON.stringify(s);
}

/** Mirrors frontmatter.ts buildPage: fixed field order, `locked` never written. */
function adapterBuildPage(frontmatter, body) {
  const fm = {};
  fm.type = (frontmatter.type ?? "other").toString();
  if (frontmatter.title != null) fm.title = frontmatter.title;
  if (frontmatter.description != null) fm.description = frontmatter.description;
  if (frontmatter.sources != null) fm.sources = frontmatter.sources;
  if (frontmatter.tags != null) fm.tags = frontmatter.tags;
  if (frontmatter.timestamp != null) fm.timestamp = frontmatter.timestamp;
  for (const [k, v] of Object.entries(frontmatter)) {
    if (["type", "title", "description", "sources", "tags", "timestamp", "locked"].includes(k)) continue;
    if (v != null) fm[k] = v;
  }
  const yamlText = Object.entries(fm)
    .map(([k, v]) => (Array.isArray(v) ? `${k}: [${v.map(scalar).join(", ")}]` : `${k}: ${scalar(v)}`))
    .join("\n");
  const cleanBody = (body ?? "").replace(/^\s+/, "").replace(/\s+$/, "");
  return `---\n${yamlText}\n---\n\n${cleanBody}\n`;
}

// The repo module (when importable) owns the tolerant parse/build path; the
// adapter supplies the raw pre-coercion view in every case.
const parseFrontmatter = repoParseFrontmatter ?? adapterParseFrontmatter;
const buildPage = repoBuildPage ?? adapterBuildPage;

// ---------------------------------------------------------------------------
// Normalization + validation gate
// ---------------------------------------------------------------------------

const ISO_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)?$/;

/** Structural normalization: BOM, CRLF, per-line trailing space, blank runs, EOF newline. */
export function normalizeMarkdownText(raw) {
  return (raw ?? "")
    .replace(/^﻿/, "") // strip BOM
    .replace(/\r\n?/g, "\n") // CRLF / CR -> LF
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, "")) // trailing whitespace
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\s+/, "")
    .replace(/\s*$/, "\n");
}

/** Canonicalize repo-like source refs; pass anything else through (normalize.ts semantics). */
export function normalizeSourceRef(ref) {
  return /@|:\/\/|\.git$/.test(ref) ? normalizeRepoUrl(ref) : ref;
}

/** Split + parse a document, keeping the raw mapping for validation. */
function analyze(text) {
  const m = text.match(FM_RE);
  if (!m) return { hasBlock: false, reason: "no `---` frontmatter block" };
  const raw = parseRawBlock(m[1]);
  return { hasBlock: true, yamlOk: raw.ok, reason: raw.reason, value: raw.value, body: text.slice(m[0].length) };
}

/**
 * Validate frontmatter metadata. Tolerance lives in the parser; strictness
 * lives here: a page whose metadata is malformed is rejected with a code and
 * never reaches the index.
 */
export function validateMetadata(meta) {
  if (!meta.hasBlock) return [{ code: "E_NO_FRONTMATTER", detail: meta.reason }];
  if (!meta.yamlOk) return [{ code: "E_YAML_INVALID", detail: meta.reason }];
  if (!meta.value || typeof meta.value !== "object")
    return [{ code: "E_YAML_NOT_MAPPING", detail: "frontmatter is not a key/value mapping" }];

  const fm = meta.value;
  const errors = [];
  if (typeof fm.type !== "string" || !fm.type.trim())
    errors.push({ code: "E_TYPE_INVALID", detail: `type must be a non-empty string, got ${JSON.stringify(fm.type)}` });
  for (const key of ["title", "description", "timestamp"]) {
    if (fm[key] != null && typeof fm[key] !== "string")
      errors.push({ code: `E_${key.toUpperCase()}_INVALID`, detail: `${key} must be a string` });
  }
  if (typeof fm.timestamp === "string" && !ISO_RE.test(fm.timestamp.trim()))
    errors.push({ code: "E_TIMESTAMP_NOT_ISO", detail: `timestamp ${JSON.stringify(fm.timestamp)} is not ISO-8601` });
  for (const key of ["sources", "tags"]) {
    if (fm[key] == null) continue;
    if (!Array.isArray(fm[key])) errors.push({ code: `E_${key.toUpperCase()}_NOT_ARRAY`, detail: `${key} must be a list` });
    else if (fm[key].some((x) => typeof x !== "string" || !x.trim()))
      errors.push({ code: `E_${key.toUpperCase()}_ITEM_INVALID`, detail: `${key} entries must be non-empty strings` });
  }
  return errors;
}

/**
 * Full pre-indexing pipeline for one document.
 * @returns {{status:"accepted",...} | {status:"rejected",...}}
 */
export function prepareDocument(name, raw) {
  const text = normalizeMarkdownText(raw);
  const meta = analyze(text);
  const errors = validateMetadata(meta);
  if (errors.length) return { name, status: "rejected", errors, indexed: false };

  const fm = meta.value;
  const body = meta.body;
  // Canonicalize + dedupe source refs (unionSources semantics from merge.ts).
  const sources = Array.isArray(fm.sources)
    ? [...new Set(fm.sources.map((s) => normalizeSourceRef(s.trim())))].sort()
    : undefined;

  const canonical = buildPage({ ...fm, sources }, body);
  const reparsed = parseFrontmatter(canonical);
  if (!reparsed.hasFrontmatter || validateMetadata(analyze(canonical)).length) {
    return { name, status: "rejected", errors: [{ code: "E_ROUNDTRIP", detail: "re-serialized page failed re-validation" }], indexed: false };
  }

  const title = typeof fm.title === "string" && fm.title.trim() ? fm.title.trim() : name.replace(/\.md$/, "");
  return {
    name,
    status: "accepted",
    frontmatter: reparsed.frontmatter,
    body: reparsed.body,
    canonical,
    entry: {
      title,
      relPath: `/${fm.type}s/${name}`,
      description: typeof fm.description === "string" ? fm.description.trim() : "",
      type: fm.type,
      sources: sources ?? [],
      sourceKey: sources?.length ? sourceKey(sources[0], "main") : undefined,
    },
    indexed: true,
  };
}

// ---------------------------------------------------------------------------
// Index rendering (mirrors ingest-v2/index-builder.ts renderIndex contract)
// ---------------------------------------------------------------------------

const GROUP_ORDER = ["source", "entity", "concept", "comparison", "synthesis"];

export function renderIndex(entries) {
  const byType = new Map();
  for (const e of entries) byType.set(e.type, [...(byType.get(e.type) ?? []), e]);
  const sections = ["# Index", ""];
  const emitted = new Set();
  const emit = (type) => {
    const items = byType.get(type);
    if (!items?.length) return;
    emitted.add(type);
    items.sort((a, b) => a.title.localeCompare(b.title));
    sections.push(`## ${type}`, "");
    for (const it of items) sections.push(`* [${it.title}](${it.relPath})${it.description ? ` - ${it.description}` : ""}`);
    sections.push("");
  };
  for (const t of GROUP_ORDER) emit(t);
  for (const t of [...byType.keys()].filter((t) => !emitted.has(t)).sort()) emit(t);
  return sections.join("\n").replace(/\n+$/, "") + "\n";
}

// ---------------------------------------------------------------------------
// Demo cases
// ---------------------------------------------------------------------------

const CASES = [
  {
    name: "messy-but-valid.md",
    why: "BOM + CRLF + trailing spaces + duplicate SSH/HTTPS source refs -> normalize, then index",
    raw:
      "﻿---\r\ntype: source\r\ntitle:   Agent Memory overview  \r\ndescription: Canonical page for the memory service\r\n" +
      "sources: [git@gitlab.example.com:tencent/tdam/repo.git, https://gitlab.example.com/tencent/tdam/repo.git]\r\n" +
      "timestamp: 2026-01-02\r\n---\r\n\r\n  The service exposes knowledge indexing and retrieval.  \r\n",
    expect: "accepted",
  },
  {
    name: "plain-valid.md",
    why: "already-canonical input must be a fixed point (idempotent normalization)",
    raw:
      "---\ntype: concept\ntitle: Retrieval pipeline\ndescription: How pages reach the index\nsources:\n  - raw/notes.md\ntimestamp: 2026-01-05\n---\n\nRetrieval is two-stage: index then drill down.\n",
    expect: "accepted",
  },
  {
    name: "unterminated-frontmatter.md",
    why: "opening --- with no closing delimiter -> reject",
    raw: "---\ntype: concept\ntitle: Half written\n\nBody without a closing fence.\n",
    expect: "rejected",
    code: "E_NO_FRONTMATTER",
  },
  {
    name: "scalar-frontmatter.md",
    why: "frontmatter parses to a scalar, not a mapping -> reject",
    raw: "---\njust a bare string\n---\n\nBody.\n",
    expect: "rejected",
    code: "E_YAML_NOT_MAPPING",
  },
  {
    name: "bad-yaml.md",
    why: "unterminated quote + unterminated flow sequence -> YAML parse error -> reject",
    raw: '---\ntype: concept\ntitle: "broken\nsources: [a, b\n---\n\nBody.\n',
    expect: "rejected",
    code: "E_YAML_INVALID",
  },
  {
    name: "wrong-type-field.md",
    why: "type present but a list: the tolerant parser would coerce it to \"other\"; the gate rejects instead",
    raw: "---\ntype: [concept]\ntitle: Listy type\n---\n\nBody.\n",
    expect: "rejected",
    code: "E_TYPE_INVALID",
  },
  {
    name: "sources-not-array.md",
    why: "sources declared as a scalar -> reject before indexing",
    raw: "---\ntype: source\ntitle: Scalar sources\nsources: one-page.md\n---\n\nBody.\n",
    expect: "rejected",
    code: "E_SOURCES_NOT_ARRAY",
  },
  {
    name: "bad-timestamp.md",
    why: "non-ISO timestamp -> reject rather than index unusable metadata",
    raw: "---\ntype: entity\ntitle: Old page\ntimestamp: last tuesday\n---\n\nBody.\n",
    expect: "rejected",
    code: "E_TIMESTAMP_NOT_ISO",
  },
];

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const assertions = [];
const assert = (label, cond) => assertions.push({ label, ok: !!cond });

const results = [];
for (const c of CASES) {
  const out = prepareDocument(c.name, c.raw);
  results.push({ name: c.name, why: c.why, expected: c.expect, ...out });
  assert(`case ${c.name} status is ${c.expect}`, out.status === c.expect);
  if (c.code) assert(`case ${c.name} reports ${c.code}`, out.errors?.some((e) => e.code === c.code));
}

// Idempotency: canonical form is a fixed point (normalize.ts pass-through spirit).
const first = results.find((r) => r.name === "messy-but-valid.md");
const second = prepareDocument("messy-but-valid.md", first.canonical);
assert("normalization is idempotent (canonical in -> identical canonical out)", second.canonical === first.canonical);

// normalizeRepoUrl canonicalization + idempotence across all spellings.
const SPELLINGS = [
  "git@gitlab.example.com:tencent/tdam/repo.git",
  "ssh://git@gitlab.example.com/tencent/tdam/repo.git",
  "https://gitlab.example.com/tencent/tdam/repo.git",
  "http://gitlab.example.com/tencent/tdam/repo",
  "gitlab.example.com/tencent/tdam/repo",
];
const canonicalForms = SPELLINGS.map(normalizeRepoUrl);
assert("all repo spellings collapse to one canonical form", new Set(canonicalForms).size === 1);
assert("normalizeRepoUrl is idempotent", canonicalForms.every((c) => normalizeRepoUrl(c) === c));
assert("sourceKey = canonical url + branch", sourceKey(SPELLINGS[0], "main") === "gitlab.example.com/tencent/tdam/repo:main");
assert(
  "parseSourceKey round-trips sourceKey",
  JSON.stringify(parseSourceKey(sourceKey(SPELLINGS[2], "dev"))) ===
    JSON.stringify({ repo: "gitlab.example.com/tencent/tdam/repo", branch: "dev" }),
);

// Accepted (post-normalization) pages get indexed; rejected ones never do.
const accepted = results.filter((r) => r.status === "accepted");
const rejected = results.filter((r) => r.status === "rejected");
assert("every rejected document is kept out of the index", rejected.every((r) => r.indexed === false));
assert("accepted documents produced index entries", accepted.every((r) => r.entry?.title));
assert(
  "messy input indexed the canonical source URL exactly once",
  first.entry.sources.length === 1 && first.entry.sources[0] === "gitlab.example.com/tencent/tdam/repo",
);
assert("messy input produced a clean canonical body", first.canonical.includes("retrieval.\n") && !first.canonical.includes("\r"));
assert("canonical page keeps frontmatter first and type present", first.canonical.startsWith("---\ntype: source\n"));

const indexText = renderIndex(accepted.map((r) => r.entry));
assert("rendered index lists accepted pages only", indexText.includes("Agent Memory overview") && !indexText.includes("Half written"));

const failed = assertions.filter((a) => !a.ok);
const run = {
  task: { task_id: 27, repository: "tdam", mode: "demo" },
  demo: "normalize markdown/frontmatter input before indexing; reject malformed metadata",
  frontmatterSource,
  normalizeModuleSource: "MemoryKnowledge/src/engines/code/normalize.ts (repo module, executed)",
  cases: results.map((r) => ({
    name: r.name,
    why: r.why,
    expected: r.expected,
    status: r.status,
    indexed: r.indexed,
    errors: r.errors ?? [],
    entry: r.entry ?? null,
  })),
  assertions,
  index: indexText,
  summary: { accepted: accepted.length, rejected: rejected.length, assertions: assertions.length, failed: failed.length },
};

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, JSON.stringify(run, null, 2) + "\n", "utf-8");

console.log(`frontmatter adapter : ${frontmatterSource}`);
console.log(`normalize.ts source : ${run.normalizeModuleSource}\n`);
for (const r of run.cases) {
  const tag = r.status === "accepted" ? "ACCEPT" : `REJECT(${r.errors.map((e) => e.code).join(",")})`;
  console.log(`  ${tag.padEnd(34)} ${r.name}`);
}
console.log(`\nassertions: ${assertions.length - failed.length}/${assertions.length} passed`);
console.log(`result written to: ${OUT_FILE}`);
if (failed.length) {
  for (const f of failed) console.error(`FAILED: ${f.label}`);
  process.exit(1);
}
console.log("OK: normalization + rejection gate behaves as specified.");
