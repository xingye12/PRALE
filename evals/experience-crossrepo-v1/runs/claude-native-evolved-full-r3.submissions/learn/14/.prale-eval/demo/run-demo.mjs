/**
 * run-demo.mjs — executable demo for the wiki-ingest helpers.
 *
 * Exercises the REAL modules under MemoryKnowledge/src/engines/wiki/ingest-v2/:
 *   - slug.ts     : imported directly (pure, no external deps)
 *   - chunker.ts  : imported directly (pure, no external deps)
 *   - frontmatter.ts : its only runtime dep is the `yaml` package, which is NOT
 *     installed in this checkout (no node_modules). The frontmatter behaviors the
 *     demo needs — FM_RE block splitting, tolerant fallback to {type:"other"},
 *     isLocked / readSources accessors, and buildPage field ordering — are
 *     mirrored locally below (see `parseFrontmatterShim`). The mirror is
 *     behavior-equivalent for the single-line scalar / block-list subset used by
 *     the corpus and is marked as a dependency limitation in result.json.
 *
 * Runs on a small local markdown corpus and prints deterministic document IDs
 * and chunk counts.
 *
 * Usage: node .prale-eval/demo/run-demo.mjs
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", ".."); // workspace root
const INGEST = join(ROOT, "MemoryKnowledge", "src", "engines", "wiki", "ingest-v2");
const CORPUS = join(HERE, "corpus");

// --- real modules, loaded via Node's native TypeScript type stripping --------
const { slugify, pageRelPath } = await import(pathToFileURL(join(INGEST, "slug.ts")).href);
const { chunkText, estimateTokens } = await import(pathToFileURL(join(INGEST, "chunker.ts")).href);

// --- local mirror of frontmatter.ts (see header note) ------------------------
const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Minimal YAML subset: scalars, quoted strings, `key:` + block list. */
function miniYaml(text) {
  const out = {};
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, rawVal] = m;
    if (rawVal === "") {
      const list = [];
      while (i + 1 < lines.length && /^\s+-\s+/.test(lines[i + 1])) {
        list.push(lines[++i].replace(/^\s+-\s+/, "").trim());
      }
      out[key] = list.length ? list : null;
      continue;
    }
    let v = rawVal.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    } else if (v === "true") v = true;
    else if (v === "false") v = false;
    out[key] = v;
  }
  return out;
}

/** Behavior-equivalent mirror of frontmatter.ts#parseFrontmatter. */
function parseFrontmatterShim(content) {
  const text = content ?? "";
  const m = text.match(FM_RE);
  if (!m) return { frontmatter: { type: "other" }, body: text, hasFrontmatter: false };
  const body = text.slice(m[0].length);
  let parsed;
  try {
    parsed = miniYaml(m[1]);
  } catch {
    return { frontmatter: { type: "other" }, body, hasFrontmatter: false };
  }
  if (!parsed || typeof parsed !== "object") {
    return { frontmatter: { type: "other" }, body, hasFrontmatter: false };
  }
  const type = typeof parsed.type === "string" && parsed.type.trim() ? parsed.type : "other";
  return { frontmatter: { ...parsed, type }, body, hasFrontmatter: true };
}

const isLocked = (content) => parseFrontmatterShim(content).frontmatter.locked === true;
const readSources = (content) => {
  const s = parseFrontmatterShim(content).frontmatter.sources;
  return Array.isArray(s) ? s.filter((x) => typeof x === "string") : [];
};

/** Mirror of frontmatter.ts#buildPage (fixed field order, never emits `locked`). */
function buildPage(frontmatter, body) {
  const fm = { type: (frontmatter.type ?? "other").toString() };
  for (const k of ["title", "description", "sources", "tags", "timestamp"]) {
    if (frontmatter[k] != null) fm[k] = frontmatter[k];
  }
  for (const [k, v] of Object.entries(frontmatter)) {
    if (["type", "title", "description", "sources", "tags", "timestamp", "locked"].includes(k)) continue;
    if (v != null) fm[k] = v;
  }
  let yamlText = Object.entries(fm)
    .map(([k, v]) =>
      Array.isArray(v) ? `${k}:\n${v.map((x) => `  - ${x}`).join("\n")}` : `${k}: ${v}`,
    )
    .join("\n");
  const cleanBody = (body ?? "").replace(/^\s+/, "").replace(/\s+$/, "");
  return `---\n${yamlText}\n---\n\n${cleanBody}\n`;
}

// --- demo: ingest the corpus -------------------------------------------------
const TARGET_CHARS = 1000; // chunker clamps target to >= 1000
const docId = (relPath) => createHash("sha256").update(relPath, "utf8").digest("hex").slice(0, 16);

const files = readdirSync(CORPUS).filter((f) => f.endsWith(".md")).sort();
const docs = [];

for (const file of files) {
  const content = readFileSync(join(CORPUS, file), "utf-8");
  const { frontmatter, body, hasFrontmatter } = parseFrontmatterShim(content);
  const title = typeof frontmatter.title === "string" && frontmatter.title.trim()
    ? frontmatter.title.trim()
    : file.replace(/\.md$/, "");
  const relPath = pageRelPath(frontmatter.type, title); // real slug.ts
  const chunks = chunkText(body, { targetChars: TARGET_CHARS }); // real chunker.ts
  docs.push({
    source_file: file,
    type: frontmatter.type,
    title,
    slug: slugify(title), // real slug.ts
    doc_id: docId(relPath),
    rel_path: relPath,
    has_frontmatter: hasFrontmatter,
    locked: isLocked(content),
    sources: readSources(content),
    body_chars: body.trim().length,
    est_tokens: estimateTokens(body),
    chunk_count: chunks.length,
    chunk_chars: chunks.map((c) => c.length),
    reparse_type: parseFrontmatterShim(buildPage(frontmatter, body)).frontmatter.type,
  });
}

const summary = {
  corpus_dir: ".prale-eval/demo/corpus",
  chunk_target_chars: TARGET_CHARS,
  document_count: docs.length,
  total_chunks: docs.reduce((n, d) => n + d.chunk_count, 0),
  documents: docs,
};

const outPath = join(HERE, "out.json");
writeFileSync(outPath, JSON.stringify(summary, null, 2) + "\n", "utf-8");

console.log(`wrote ${outPath}`);
for (const d of docs) {
  console.log(
    `${d.source_file}\n  doc_id=${d.doc_id} slug=${d.slug} rel_path=${d.rel_path}` +
      ` type=${d.type} fm=${d.has_frontmatter} locked=${d.locked}` +
      ` chunks=${d.chunk_count} ${JSON.stringify(d.chunk_chars)}`,
  );
}
console.log(`documents=${summary.document_count} total_chunks=${summary.total_chunks}`);
