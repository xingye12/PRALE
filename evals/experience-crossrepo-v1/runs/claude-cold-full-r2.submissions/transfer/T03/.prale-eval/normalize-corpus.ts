/**
 * normalize-corpus.ts — executable contract demo for task T03 (repo `tdam`, mode `contract`).
 *
 * What it proves, on a corpus that is NOT the repository's own docs:
 *   1. Normalization is DETERMINISTIC: the same corpus yields byte-identical
 *      normalized output across repeated runs and across seeded shuffles of the
 *      input order.
 *   2. Normalization is IDEMPOTENT: re-normalizing an already-normalized slug
 *      or page path is a fixed point.
 *   3. Invalid metadata is handled EXPLICITLY: every deviation (missing /
 *      unterminated frontmatter, malformed YAML, non-string `type`, blank
 *      `type`, scalar `sources`, non-boolean `locked`, missing `title`) is
 *      reported as a typed diagnostic instead of being silently accepted or
 *      silently dropped.
 *   4. Duplicate headings: repeated heading text inside one document resolves
 *      to stable, ordinal-suffixed section anchors; repeated entities across
 *      documents collapse onto ONE normalized target path (dedup / merge)
 *      rather than racing for the same file name.
 *
 * The normalization primitives are imported directly from the repository under
 * test — `slugify`, `dirForType`, `pageRelPath` from
 * `MemoryKnowledge/src/engines/wiki/ingest-v2/slug.ts`. That module has no
 * third-party imports, so Node >= 22.18 type-stripping runs this demo with no
 * build step and no installed dependencies.
 *
 * Limitation (recorded in result.json validation.notes): the repository's own
 * `frontmatter.ts` imports the `yaml` package, which is not installed in this
 * checkout and must not be installed. The tolerant frontmatter contract below
 * (fence split, YAML-failure downgrade to `type:"other"`, blank/non-string
 * `type` fallback, `sources` array requirement, strict `locked === true`) is
 * therefore re-implemented here over a documented minimal YAML subset, mirroring
 * frontmatter.ts:42-76 line for line in observable behaviour.
 *
 * Run:  node .prale-eval/normalize-corpus.ts
 * Exit: 0 = all determinism/idempotence/contract assertions held; 1 = a check failed.
 */

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { slugify, dirForType, pageRelPath } from "../MemoryKnowledge/src/engines/wiki/ingest-v2/slug.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(HERE, "corpus");
const REPORT_PATH = join(HERE, "normalized-report.json");

// ---------------------------------------------------------------------------
// Diagnostics — the explicit channel for invalid metadata.
// ---------------------------------------------------------------------------

type Severity = "info" | "warn";
interface Diagnostic {
  file: string;
  code: string;
  severity: Severity;
  detail: string;
}

/** Codes minted by this demo; every one is asserted to fire on the corpus. */
const EXPECTED_CODES = [
  "NO_FRONTMATTER",
  "UNTERMINATED_FRONTMATTER",
  "YAML_PARSE_ERROR",
  "TYPE_ABSENT",
  "TYPE_NOT_STRING",
  "TYPE_EMPTY",
  "SOURCES_NOT_ARRAY",
  "LOCKED_NOT_BOOLEAN",
  "TITLE_MISSING",
  "DUPLICATE_HEADING",
] as const;

// ---------------------------------------------------------------------------
// Tolerant frontmatter contract (mirrors frontmatter.ts behaviour).
// ---------------------------------------------------------------------------

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

interface Parsed {
  /**
   * Raw frontmatter record exactly as written (NOT pre-normalized) so that
   * field-level defects stay observable. frontmatter.ts:60 folds any bad
   * `type` down to "other" inside the parser; this demo instead keeps the raw
   * value and reports the fold explicitly.
   */
  fm: Record<string, unknown>;
  body: string;
  hasFrontmatter: boolean;
}

/**
 * Split page text into frontmatter + body, never throwing.
 * Mirrors `parseFrontmatter` in frontmatter.ts:42-62, including the
 * YAML-failure downgrade to `{type:"other"}` with `hasFrontmatter:false`.
 */
function parsePage(text: string, file: string, diags: Diagnostic[]): Parsed {
  const m = FM_RE.exec(text);
  if (!m) {
    // Starts with an opening fence but never closed -> distinct, explicit case.
    const startsWithFence = /^---\r?\n/.test(text);
    diags.push(
      startsWithFence
        ? { file, code: "UNTERMINATED_FRONTMATTER", severity: "warn", detail: "opening `---` fence has no closing fence; treated as body" }
        : { file, code: "NO_FRONTMATTER", severity: "info", detail: "no frontmatter block; type falls back to \"other\"" },
    );
    return { fm: {}, body: text, hasFrontmatter: false };
  }
  const yamlText = m[1];
  const body = text.slice(m[0].length);
  const parsed = parseYamlSubset(yamlText);
  if (!parsed.ok) {
    diags.push({ file, code: "YAML_PARSE_ERROR", severity: "warn", detail: parsed.error });
    return { fm: {}, body, hasFrontmatter: false };
  }
  return { fm: parsed.value, body, hasFrontmatter: true };
}

/**
 * Minimal YAML subset: flat `key: scalar`, `key:` (null), `key: [a, b]`.
 * Anything outside the subset (nested maps, tabs, unterminated flow sequences)
 * is a hard parse error — which the caller downgrades exactly like the `yaml`
 * package would in frontmatter.ts:51-55.
 */
function parseYamlSubset(src: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const out: Record<string, unknown> = {};
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    if (/^\s/.test(raw)) return { ok: false, error: `line ${i + 1}: unexpected indentation (nested block unsupported): ${JSON.stringify(raw)}` };
    const kv = /^([A-Za-z_][\w-]*)\s*:(.*)$/.exec(raw);
    if (!kv) return { ok: false, error: `line ${i + 1}: not a key/value pair: ${JSON.stringify(raw)}` };
    const key = kv[1];
    const rest = kv[2].trim();
    if (rest === "") {
      out[key] = null;
      continue;
    }
    if (rest.startsWith("[")) {
      if (!rest.endsWith("]")) return { ok: false, error: `line ${i + 1}: unterminated flow sequence for \`${key}\`` };
      out[key] = rest
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(unquote);
      continue;
    }
    out[key] = scalar(rest);
  }
  return { ok: true, value: out };
}

function unquote(s: string): string {
  return /^".*"$|^'.*'$/.test(s) ? s.slice(1, -1) : s;
}

function scalar(s: string): unknown {
  if (/^-?\d+$/.test(s)) return Number(s);
  if (s === "true") return true;
  if (s === "false") return false;
  return unquote(s);
}

// ---------------------------------------------------------------------------
// Normalization.
// ---------------------------------------------------------------------------

const HEADING_RE = /^(#{1,6})\s+(\S.*)$/;

interface Section {
  /** Ordinal position in the document (1-based). */
  position: number;
  level: number;
  text: string;
  /** Deterministic anchor: normalized text, ordinal-suffixed on repetition. */
  anchor: string;
  duplicateOf: string | null;
}

/**
 * Normalize a document's headings. Duplicate heading text is resolved with an
 * ordinal suffix (`overview`, `overview-2`, ...) so that repeated headings map
 * to stable, collision-free section anchors instead of overwriting each other.
 */
function normalizeSections(body: string, file: string, diags: Diagnostic[]): Section[] {
  const seen = new Map<string, number>();
  const sections: Section[] = [];
  let position = 0;
  for (const line of body.split(/\r?\n/)) {
    const m = HEADING_RE.exec(line);
    if (!m) continue;
    position++;
    const text = m[2].trim();
    const base = slugify(text);
    const key = base || "untitled";
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    const anchor = n === 1 ? key : `${key}-${n}`;
    if (n > 1) {
      diags.push({ file, code: "DUPLICATE_HEADING", severity: "info", detail: `heading ${JSON.stringify(text)} repeats; anchored as ${JSON.stringify(anchor)}` });
    }
    sections.push({ position, level: m[1].length, text, anchor, duplicateOf: n === 1 ? null : base });
  }
  return sections;
}

/** Metadata extraction with explicit validity reporting; returns normalized values. */
function normalizeMetadata(p: Parsed, file: string, stem: string, diags: Diagnostic[]) {
  const raw = p.fm;
  let type = "other";
  if (!p.hasFrontmatter) {
    diags.push({ file, code: "TYPE_ABSENT", severity: "info", detail: "no parsed frontmatter, so `type` falls back to \"other\" (frontmatter.ts:60)" });
  } else if (!("type" in raw)) {
    diags.push({ file, code: "TYPE_ABSENT", severity: "warn", detail: "`type` key absent; fell back to \"other\" (frontmatter.ts:60)" });
  } else if (raw.type == null) {
    diags.push({ file, code: "TYPE_EMPTY", severity: "warn", detail: "`type:` is present with no value (YAML null); fell back to \"other\"" });
  } else if (typeof raw.type !== "string") {
    diags.push({ file, code: "TYPE_NOT_STRING", severity: "warn", detail: `\`type\` is ${typeof raw.type} (${JSON.stringify(raw.type)}), not a string; fell back to "other"` });
  } else if (!raw.type.trim()) {
    diags.push({ file, code: "TYPE_EMPTY", severity: "warn", detail: "`type` present but blank; fell back to \"other\"" });
  } else {
    type = raw.type;
  }

  const rawSources = raw.sources;
  let sources: string[] = [];
  if (rawSources !== undefined && rawSources !== null) {
    if (Array.isArray(rawSources)) {
      sources = rawSources.filter((s): s is string => typeof s === "string" && !!s.trim()).map((s) => s.trim());
    } else {
      diags.push({ file, code: "SOURCES_NOT_ARRAY", severity: "warn", detail: `\`sources\` is ${typeof rawSources} (${JSON.stringify(rawSources)}); readSources contract requires a list, treated as []` });
    }
  }

  let locked = false;
  if (raw.locked !== undefined && raw.locked !== null) {
    if (raw.locked === true) locked = true;
    else if (raw.locked === false) locked = false;
    else diags.push({ file, code: "LOCKED_NOT_BOOLEAN", severity: "warn", detail: `\`locked\` is ${typeof raw.locked} (${JSON.stringify(raw.locked)}); strict \`=== true\` means the page is NOT locked` });
  }

  let title: string;
  if (typeof raw.title === "string" && raw.title.trim()) {
    title = raw.title.trim();
  } else {
    const first = p.body.split(/\r?\n/).find((l) => HEADING_RE.test(l));
    title = first ? HEADING_RE.exec(first)![2].trim() : stem;
    diags.push({ file, code: "TITLE_MISSING", severity: "warn", detail: `no usable \`title\`; derived ${JSON.stringify(title)} from ${first ? "first heading" : "file name"}` });
  }

  return { type, typeNorm: type, sources, locked, title };
}

interface DocResult {
  file: string;
  hasFrontmatter: boolean;
  type: string;
  title: string;
  slug: string;
  pagePath: string;
  sources: string[];
  locked: boolean;
  sections: Section[];
}

function normalizeDocument(file: string, text: string, diags: Diagnostic[]): DocResult {
  const stem = file.replace(/\.[^.]+$/, "");
  const parsed = parsePage(text, file, diags);
  const meta = normalizeMetadata(parsed, file, stem, diags);
  const sections = normalizeSections(parsed.body, file, diags);
  const slug = slugify(meta.title);
  if (!slug) diags.push({ file, code: "EMPTY_SLUG", severity: "warn", detail: `title ${JSON.stringify(meta.title)} normalizes to an empty slug` });
  return {
    file,
    hasFrontmatter: parsed.hasFrontmatter,
    type: meta.type,
    title: meta.title,
    slug,
    pagePath: pageRelPath(meta.type, meta.title),
    sources: meta.sources,
    locked: meta.locked,
    sections,
  };
}

// ---------------------------------------------------------------------------
// Report assembly (deterministic ordering everywhere).
// ---------------------------------------------------------------------------

function buildReport(docs: DocResult[], diags: Diagnostic[], order: string[]) {
  const entities = new Map<string, { pagePath: string; dir: string; slug: string; titles: Set<string>; files: string[]; sources: Set<string>; locked: boolean }>();
  for (const d of docs) {
    const dir = dirForType(d.type);
    let e = entities.get(d.pagePath);
    if (!e) {
      e = { pagePath: d.pagePath, dir, slug: d.slug, titles: new Set(), files: [], sources: new Set(), locked: false };
      entities.set(d.pagePath, e);
    }
    e.titles.add(d.title);
    e.files.push(d.file);
    for (const s of d.sources) e.sources.add(s);
    e.locked = e.locked || d.locked;
  }
  const entityList = [...entities.values()]
    .map((e) => ({
      pagePath: e.pagePath,
      dir: e.dir,
      slug: e.slug,
      titles: [...e.titles].sort(),
      files: [...e.files].sort(),
      sources: [...e.sources].sort(),
      mergedDocuments: e.files.length,
      locked: e.locked,
    }))
    .sort((a, b) => (a.pagePath < b.pagePath ? -1 : a.pagePath > b.pagePath ? 1 : 0));

  return {
    order,
    documents: [...docs].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)),
    entities: entityList,
    diagnostics: [...diags].sort((a, b) => (a.file + " " + a.code + " " + a.detail < b.file + " " + b.code + " " + b.detail ? -1 : 1)),
  };
}

/** Canonical JSON (all object keys sorted) so hashes are stable. */
function canonical(v: unknown): string {
  return JSON.stringify(sortKeys(v));
}
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  }
  return v;
}
function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

// ---------------------------------------------------------------------------
// Drive.
// ---------------------------------------------------------------------------

function loadCorpus(): { name: string; text: string }[] {
  return readdirSync(CORPUS_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => ({ name: f, text: readFileSync(join(CORPUS_DIR, f), "utf-8") }));
}

function runOnce(corpus: { name: string; text: string }[], orderLabel: string) {
  const diags: Diagnostic[] = [];
  const docs = corpus.map((c) => normalizeDocument(c.name, c.text, diags));
  return buildReport(docs, diags, orderLabel);
}

/** Deterministic PRNG (mulberry32) so the "shuffled" runs are themselves reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle<T>(arr: T[], rnd: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const corpus = loadCorpus();
const failures: string[] = [];

// Run 1 and run 2: identical input order, must be byte-identical.
const r1 = runOnce(corpus, "file-order");
const r2 = runOnce(corpus, "file-order");
/** The compared payload: everything except the run's informational `order` label. */
function payload(r: ReturnType<typeof runOnce>) {
  const { order: _order, ...rest } = r;
  return rest;
}
const h1 = sha256(canonical(payload(r1)));
const h2 = sha256(canonical(payload(r2)));
if (h1 !== h2) failures.push(`repeat runs differ: ${h1} vs ${h2}`);

// Runs 3..5: seeded shuffles; the normalized result must be order-independent.
const shuffleHashes: string[] = [];
for (const seed of [1, 7, 20261003]) {
  const r = runOnce(shuffle(corpus, mulberry32(seed)), `shuffle(seed=${seed})`);
  shuffleHashes.push(sha256(canonical(payload(r))));
}
const orderIndependent = shuffleHashes.every((h) => h === h1);
if (!orderIndependent) failures.push(`shuffled runs differ from file-order: ${[h1, ...shuffleHashes].join(", ")}`);

// Idempotence: slugs and page paths are fixed points of re-normalization.
const nonIdempotent: string[] = [];
for (const d of r1.documents) {
  if (d.slug && slugify(d.slug) !== d.slug) nonIdempotent.push(`${d.file}: slugify(${d.slug}) = ${slugify(d.slug)}`);
  if (pageRelPath(d.type, d.title) !== d.pagePath) nonIdempotent.push(`${d.file}: pageRelPath not pure`);
  for (const s of d.sections) if (slugify(s.anchor) !== s.anchor) nonIdempotent.push(`${d.file}: anchor ${s.anchor} -> ${slugify(s.anchor)}`);
}
if (nonIdempotent.length) failures.push(...nonIdempotent);

// Every expected diagnostic code must actually fire on this corpus.
const firedCodes = new Set(r1.diagnostics.map((d) => d.code));
const missingCodes = EXPECTED_CODES.filter((c) => !firedCodes.has(c));
if (missingCodes.length) failures.push(`expected diagnostics never fired: ${missingCodes.join(", ")}`);

// Duplicate-heading handling must be visible and ordinal-stable.
const dupFiles = r1.documents.filter((d) => d.sections.some((s) => s.duplicateOf));
if (!dupFiles.length) failures.push("no document exercised duplicate headings");

// Cross-document duplicate entity must collapse to a single page path.
const merged = r1.entities.filter((e) => e.mergedDocuments > 1);
if (!merged.length) failures.push("no cross-document duplicate entity collapsed onto one page path");

const report = {
  task: "T03",
  repository: "tdam",
  mode: "contract",
  corpusDir: ".prale-eval/corpus",
  documents: r1.documents.length,
  entities: r1.entities.length,
  diagnostics: r1.diagnostics.length,
  result: r1,
  determinism: {
    runs: 2 + shuffleHashes.length,
    canonicalSha256: h1,
    repeatRunMatch: h1 === h2,
    orderIndependent,
    shuffleHashes,
    idempotent: nonIdempotent.length === 0,
    expectedCodesAllFired: missingCodes.length === 0,
  },
  assertions: { passed: failures.length === 0, failures },
};
writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + "\n", "utf-8");

// Human-readable summary.
console.log(`corpus: ${r1.documents.length} documents -> ${r1.entities.length} normalized wiki pages`);
console.log(`canonical sha256: ${h1} (repeat match=${h1 === h2}, order-independent=${orderIndependent}, idempotent=${nonIdempotent.length === 0})`);
console.log(`diagnostics: ${r1.diagnostics.length}`);
for (const d of r1.diagnostics) console.log(`  [${d.severity}] ${d.code} ${d.file}: ${d.detail}`);
console.log("\nnormalized pages:");
for (const e of r1.entities) console.log(`  ${e.pagePath}  <- ${e.files.join(", ")}`);
if (failures.length) {
  console.error("\nASSERTION FAILURES:");
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nOK: deterministic, idempotent, invalid metadata handled explicitly.");
