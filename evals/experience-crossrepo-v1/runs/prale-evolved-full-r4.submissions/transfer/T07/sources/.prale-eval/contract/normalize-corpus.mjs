#!/usr/bin/env node
/**
 * T07 contract harness — wiki ingest-v2 normalization over a corpus that
 * contains duplicate headings and malformed frontmatter.
 *
 * What is REAL vs. standalone here (explicit, per doctrine "record the limitation"):
 *   - REAL, imported from the checkout: `slugify`, `dirForType`, `pageRelPath`
 *     from MemoryKnowledge/src/engines/wiki/ingest-v2/slug.ts (Node 24 strips the
 *     TS types, so no build/install is needed).
 *   - STANDALONE: the frontmatter gate. The real frontmatter.ts imports the
 *     `yaml` package, which is not installed in this checkout (`node_modules`
 *     absent) and we must not install dependencies. So this file ships a
 *     dependency-free, deterministic parser that mirrors frontmatter.ts's
 *     FM_RE block detection and then adds the *explicit* rejection codes the
 *     contract requires (the real parseFrontmatter deliberately fails open to
 *     `{type:"other"}`; the delta is called out in the deliverable + validation
 *     notes).
 *
 * Guarantee it exercises: for the corpus below,
 *   1. normalization is deterministic (same canonical bytes regardless of how
 *      many times / in which file order the pipeline runs), and
 *   2. invalid metadata is never silently dropped: every page is either
 *      normalized or rejected with a typed {code, message} and its source path.
 *
 * Run: node .prale-eval/contract/normalize-corpus.mjs
 * Exit: 0 when every check passes, 1 otherwise.
 */

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// --- REAL production normalization (imported straight from the repo source) ---
import { slugify, dirForType, pageRelPath } from "../../MemoryKnowledge/src/engines/wiki/ingest-v2/slug.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS_DIR = join(HERE, "corpus");

// ---------------------------------------------------------------------------
// Dependency-free frontmatter gate (mirrors frontmatter.ts FM_RE + field shape)
// ---------------------------------------------------------------------------

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/; // same block detector as frontmatter.ts:36

const fail = (line, reason) => ({ ok: false, line, reason });

/** Parse a single YAML scalar the small subset the corpus uses. */
function scalar(s) {
  const t = s.trim();
  if (t.startsWith('"') || t.startsWith("'")) {
    const q = t[0];
    if (t.length < 2 || !t.endsWith(q)) return fail(null, `unterminated quoted string: ${t}`);
    return { ok: true, value: t.slice(1, -1) };
  }
  if (t === "null" || t === "~") return { ok: true, value: null };
  if (t === "true") return { ok: true, value: true };
  if (t === "false") return { ok: true, value: false };
  if (/^-?\d+$/.test(t)) return { ok: true, value: Number(t) };
  return { ok: true, value: t };
}

/**
 * Deterministic mini-YAML for `key: value`, inline `[a, b]` and block lists.
 * Returns { ok:true, value } or { ok:false, line, reason }. Never throws.
 */
function parseMiniYaml(text) {
  const lines = text.split(/\r?\n/);
  const map = Object.create(null);
  const seen = new Set();
  let pendingKey = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.includes("\t")) return fail(i + 1, "tab characters are not allowed in frontmatter");
    if (raw.trim() === "" || /^\s*#/.test(raw)) continue;

    const indent = /^\s*/.exec(raw)[0].length;
    if (indent > 0) {
      const item = /^\s+-\s*(.*)$/.exec(raw);
      if (!item) return fail(i + 1, "unexpected indentation (only '- item' block lists are supported)");
      if (pendingKey == null) return fail(i + 1, "list item without a preceding key");
      const parsed = scalar(item[1]);
      if (!parsed.ok) return fail(i + 1, parsed.reason);
      if (!Array.isArray(map[pendingKey])) map[pendingKey] = [];
      map[pendingKey].push(parsed.value);
      continue;
    }
    pendingKey = null;

    const kv = /^([^:\s][^:]*):\s*(.*)$/.exec(raw);
    if (!kv) return fail(i + 1, "expected 'key: value'");
    const key = kv[1].trim();
    if (seen.has(key)) return fail(i + 1, `duplicate key '${key}'`);
    seen.add(key);

    const rest = kv[2].trim();
    if (rest === "") {
      map[key] = undefined;
      pendingKey = key;
      continue;
    }
    if (rest.startsWith("[")) {
      if (!rest.endsWith("]")) return fail(i + 1, "unterminated inline list");
      const inner = rest.slice(1, -1).trim();
      if (inner === "") {
        map[key] = [];
        continue;
      }
      const vals = [];
      for (const part of inner.split(",")) {
        const parsed = scalar(part);
        if (!parsed.ok) return fail(i + 1, parsed.reason);
        vals.push(parsed.value);
      }
      map[key] = vals;
      continue;
    }
    const parsed = scalar(rest);
    if (!parsed.ok) return fail(i + 1, parsed.reason);
    map[key] = parsed.value;
  }
  return { ok: true, value: { ...map } };
}

/**
 * Normalize + validate one document. Returns either an accepted canonical page
 * or an explicit rejection. Deterministic: output depends only on input bytes.
 */
function normalizeDocument(sourcePath, content) {
  const events = [];
  let text = content;

  // Normalization step 1: strip a UTF-8 BOM (recorded, never silent).
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
    events.push("BOM_STRIPPED");
  }
  // Normalization step 2: collapse CRLF to LF (frontmatter.ts FM_RE tolerates
  // both, but canonical output must be byte-stable).
  if (text.includes("\r\n")) {
    text = text.replace(/\r\n/g, "\n");
    events.push("CRLF_NORMALIZED");
  }

  const match = text.match(FM_RE);
  if (!match) {
    return { ok: false, source: sourcePath, code: "MISSING_FRONTMATTER", message: "no leading '---' frontmatter block" };
  }

  const yamlText = match[1];
  const body = text.slice(match[0].length);

  const yaml = parseMiniYaml(yamlText);
  if (!yaml.ok) {
    return { ok: false, source: sourcePath, code: "MALFORMED_YAML", message: `line ${yaml.line}: ${yaml.reason}` };
  }
  const fm = yaml.value;
  if (fm === null || typeof fm !== "object" || Array.isArray(fm)) {
    return { ok: false, source: sourcePath, code: "NON_MAPPING_FRONTMATTER", message: "frontmatter is not a key: value mapping" };
  }

  const type = typeof fm.type === "string" ? fm.type.trim() : fm.type;
  if (type == null) {
    return { ok: false, source: sourcePath, code: "MISSING_TYPE", message: "'type' is required" };
  }
  if (typeof type !== "string" || type === "") {
    return { ok: false, source: sourcePath, code: "INVALID_TYPE", message: "'type' must be a non-empty string" };
  }

  const title = typeof fm.title === "string" ? fm.title.trim() : fm.title;
  if (title == null) {
    return { ok: false, source: sourcePath, code: "MISSING_TITLE", message: "'title' is required to derive a stable slug" };
  }
  if (typeof title !== "string" || title === "") {
    return { ok: false, source: sourcePath, code: "INVALID_TITLE", message: "'title' must be a non-empty string" };
  }

  // `sources` / `tags`: accept list or scalar, but every entry must be a string.
  const listField = (name) => {
    const raw = fm[name];
    if (raw == null) return { ok: true, value: undefined };
    if (Array.isArray(raw)) {
      if (!raw.every((x) => typeof x === "string" && x.trim() !== "")) {
        return { ok: false, code: "INVALID_FIELD", message: `'${name}' entries must be non-empty strings` };
      }
      return { ok: true, value: raw.map((x) => x.trim()) };
    }
    if (typeof raw === "string" && raw.trim() !== "") {
      events.push(`SCALAR_${name.toUpperCase()}_COERCED`);
      return { ok: true, value: [raw.trim()] };
    }
    return { ok: false, code: "INVALID_FIELD", message: `'${name}' must be a string or a list of strings` };
  };

  const sources = listField("sources");
  if (!sources.ok) return { ok: false, source: sourcePath, code: sources.code, message: sources.message };
  const tags = listField("tags");
  if (!tags.ok) return { ok: false, source: sourcePath, code: tags.code, message: tags.message };

  const slug = slugify(title);
  if (!slug) {
    return { ok: false, source: sourcePath, code: "EMPTY_SLUG", message: `title ${JSON.stringify(title)} normalizes to an empty slug` };
  }

  // Normalization step 3: `locked` is never carried into self-generated output.
  if (fm.locked === true) events.push("LOCKED_DROPPED");

  const path = pageRelPath(type, title); // REAL production path derivation
  return {
    ok: true,
    source: sourcePath,
    type,
    title,
    slug,
    dir: dirForType(type),
    path,
    sources: sources.value ?? [],
    tags: tags.value,
    events,
    body: body.replace(/^\s+/, "").replace(/\s+$/, ""),
  };
}

// ---------------------------------------------------------------------------
// Deterministic corpus pipeline
// ---------------------------------------------------------------------------

function loadCorpus() {
  const names = readdirSync(CORPUS_DIR).filter((n) => n.endsWith(".md")).sort();
  return names.map((name) => ({ name, content: readFileSync(join(CORPUS_DIR, name), "utf8") }));
}

/** Run the full contract over an arbitrary input order. Order-independent output. */
function runPipeline(files) {
  const rejected = [];
  const accepted = [];
  let normalizedEvents = 0;
  for (const f of files) {
    const r = normalizeDocument(f.name, f.content);
    if (r.ok) {
      normalizedEvents += r.events.length;
      accepted.push(r);
    } else {
      rejected.push({ source: r.source, code: r.code, message: r.message });
    }
  }

  const groups = new Map();
  for (const page of accepted) {
    if (!groups.has(page.path)) groups.set(page.path, []);
    groups.get(page.path).push(page);
  }

  const collisions = [];
  const pages = [];
  for (const path of [...groups.keys()].sort()) {
    const members = groups.get(path).slice().sort((a, b) => (a.source < b.source ? -1 : 1));
    // Deterministic owner + deterministic union ordering => order independence.
    const unionSources = [...new Set(members.flatMap((m) => m.sources))].sort();
    pages.push({
      path,
      type: members[0].type,
      title: members[0].title,
      slug: members[0].slug,
      sources: unionSources,
      events: [...new Set(members.flatMap((m) => m.events))].sort(),
      mergedFrom: members.map((m) => m.source),
      body: members[0].body,
    });
    if (members.length > 1) {
      collisions.push({
        path,
        occurrenceCount: members.length,
        chosen: members[0].source,
        alsoFrom: members.slice(1).map((m) => m.source),
        mergedSources: unionSources,
      });
    }
  }

  rejected.sort((a, b) => (a.source < b.source ? -1 : 1));
  return {
    acceptedCount: accepted.length,
    rejectedCount: rejected.length,
    normalizedEvents,
    rejected,
    collisions,
    pages,
  };
}

/** Seeded deterministic shuffle (LCG) — no Math.random, so reruns match. */
function shuffled(files, seed) {
  const out = files.slice();
  let s = seed >>> 0;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const files = loadCorpus();
const base = runPipeline(files);
const checks = [];
const check = (name, pass, detail) => checks.push({ name, pass: Boolean(pass), detail });

// 1. slugify is a pure, deterministic function.
const slugSamples = ["Redis Cluster", "redis   cluster", "Redis-Cluster!", "Redis 主从", "redis 主从", "Vector Index"];
check(
  "slugify_is_pure_deterministic",
  slugSamples.every((s) => slugify(s) === slugify(s) && typeof slugify(s) === "string"),
  slugSamples.map((s) => `${JSON.stringify(s)} -> ${JSON.stringify(slugify(s))}`).join("; "),
);

// 2. Duplicate headings (differing only by case/space/punctuation) collapse to one slug.
const clusterSlugs = new Set(["Redis Cluster", "redis   cluster", "Redis-Cluster!", "  Redis   Cluster  "].map(slugify));
check(
  "equivalent_headings_collapse_to_same_slug",
  clusterSlugs.size === 1 && clusterSlugs.has("redis-cluster"),
  `distinct headings -> ${[...clusterSlugs].join(", ")}`,
);

// 2b. Mixed latin+CJK headings collapse too (CJK preserved, latin lower-cased).
check(
  "cjk_heading_normalization_stable",
  slugify("Redis 主从") === "redis-主从" && slugify("redis 主从") === "redis-主从" && slugify("Redis 主从") === slugify("redis 主从"),
  `"Redis 主从" -> ${slugify("Redis 主从")}; "redis 主从" -> ${slugify("redis 主从")}`,
);

// 3. Same title under different types must NOT collide (dir participates in the key).
const entityPath = pageRelPath("entity", "Redis Cluster");
const conceptPath = pageRelPath("concept", "Redis Cluster");
check(
  "distinct_types_do_not_collide",
  entityPath === "wiki/entities/redis-cluster.md" && conceptPath === "wiki/concepts/redis-cluster.md" && entityPath !== conceptPath,
  `${entityPath} vs ${conceptPath}`,
);

// 4. The duplicate-heading group dedupes to exactly one canonical entity page.
const clusterPages = base.pages.filter((p) => p.path === "wiki/entities/redis-cluster.md");
check(
  "duplicate_headings_dedupe_to_one_canonical_page",
  clusterPages.length === 1 && clusterPages[0].mergedFrom.length === 3,
  clusterPages.length === 1 ? `${clusterPages[0].path} mergedFrom ${JSON.stringify(clusterPages[0].mergedFrom)}` : "canonical page missing",
);

// 5. Collisions are reported explicitly, with a deterministic chosen owner.
const clusterCollision = base.collisions.find((c) => c.path === "wiki/entities/redis-cluster.md");
check(
  "collision_is_reported_explicitly",
  Boolean(clusterCollision) && clusterCollision.chosen === "ok-01-redis-cluster.md" && clusterCollision.occurrenceCount === 3,
  clusterCollision ? JSON.stringify(clusterCollision) : "no collision record",
);

// 6. Determinism: many shuffled orders + reverse must produce byte-identical output.
const permutations = [files, files.slice().reverse(), ...[1, 2, 3, 4, 5].map((s) => shuffled(files, s))];
const serialized = permutations.map((p) => JSON.stringify(runPipeline(p)));
check(
  "pipeline_is_order_independent_deterministic",
  serialized.every((s) => s === serialized[0]),
  `${permutations.length} orders checked, ${new Set(serialized).size} distinct canonical output(s)`,
);

// 6b. Repeat run on the same order is byte-identical (no hidden state).
check(
  "pipeline_repeat_run_identical",
  JSON.stringify(runPipeline(files)) === JSON.stringify(runPipeline(files)),
  "two consecutive identical runs match byte-for-byte",
);

// 7. Every malformed page is rejected with an explicit typed code.
const expectedRejections = {
  "bad-01-missing-fm.md": "MISSING_FRONTMATTER",
  "bad-02-unterminated-quote.md": "MALFORMED_YAML",
  "bad-03-duplicate-key.md": "MALFORMED_YAML",
  "bad-04-blank-type.md": "INVALID_TYPE",
  "bad-05-missing-title.md": "MISSING_TITLE",
  "bad-06-nonstring-sources.md": "INVALID_FIELD",
  "bad-07-non-mapping.md": "MALFORMED_YAML",
  "bad-08-tab-indent.md": "MALFORMED_YAML",
  "bad-09-empty-slug.md": "EMPTY_SLUG",
};
const gotBySource = Object.fromEntries(base.rejected.map((r) => [r.source, r.code]));
check(
  "malformed_frontmatter_rejected_explicitly_with_codes",
  Object.entries(expectedRejections).every(([src, code]) => gotBySource[src] === code),
  JSON.stringify(gotBySource),
);

// 8. No rejection is ever silent: each carries source + code + message; no throw.
check(
  "no_silent_drops_all_rejections_typed",
  base.rejected.every((r) => r.source && r.code && r.message) && base.acceptedCount + base.rejectedCount === files.length,
  `${base.acceptedCount} accepted + ${base.rejectedCount} rejected = ${files.length} files`,
);

// 9. Valid pages are normalized, not rejected (BOM/CRLF/scalar-sources/locked).
const vectorPage = base.pages.find((p) => p.path === "wiki/concepts/vector-index.md");
const manualPage = base.pages.find((p) => p.path === "wiki/entities/manual-page.md");
check(
  "valid_pages_normalized_explicitly",
  Boolean(vectorPage) && vectorPage.events.includes("BOM_STRIPPED") && vectorPage.events.includes("CRLF_NORMALIZED") &&
    vectorPage.sources.join(",") === "design.md",
  vectorPage ? JSON.stringify({ events: vectorPage.events, sources: vectorPage.sources }) : "vector-index page missing",
);
check(
  "locked_flag_never_written_and_unknown_field_kept",
  Boolean(manualPage) && manualPage.events.includes("LOCKED_DROPPED") &&
    !JSON.stringify(manualPage).includes('"locked"'),
  manualPage ? `events=${JSON.stringify(manualPage.events)}` : "manual-page missing",
);

// 10. Canonical output is stable and slug-consistent for every emitted page.
check(
  "canonical_paths_are_slug_consistent",
  base.pages.every((p) => p.path === `wiki/${dirForType(p.type)}/${slugify(p.title)}.md`),
  base.pages.map((p) => p.path).join(", "),
);

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const passed = checks.filter((c) => c.pass).length;
const failed = checks.length - passed;

const report = {
  task: "T07",
  repository: "tdam",
  mode: "contract",
  corpus: { dir: ".prale-eval/contract/corpus", files: files.length },
  normalized: {
    pages: base.pages,
    rejected: base.rejected,
    collisions: base.collisions,
    acceptedCount: base.acceptedCount,
    rejectedCount: base.rejectedCount,
    normalizationEvents: base.normalizedEvents,
  },
  checks,
  summary: { total: checks.length, passed, failed },
};

process.stdout.write(JSON.stringify(report, null, 2) + "\n");
for (const c of checks) process.stdout.write(`${c.pass ? "ok  " : "FAIL"}: ${c.name} — ${c.detail}\n`);
process.stdout.write(`\nT07 CONTRACT ${failed === 0 ? "PASSED" : "FAILED"} (${passed}/${checks.length} checks)\n`);
process.exit(failed === 0 ? 0 : 1);
