#!/usr/bin/env node
/**
 * run-demo.mjs — executable demo of the wiki-ingest helpers on a local markdown corpus.
 *
 * It imports the REAL repository modules (no re-implementation):
 *   MemoryKnowledge/src/engines/wiki/ingest-v2/slug.ts        (slugify, dirForType, pageRelPath)
 *   MemoryKnowledge/src/engines/wiki/ingest-v2/frontmatter.ts (parseFrontmatter, buildPage, isLocked, readSources)
 *   MemoryKnowledge/src/engines/wiki/ingest-v2/chunker.ts     (chunkText, estimateTokens)
 *
 * Node 24 executes the `.ts` sources via built-in type stripping; the bare `yaml`
 * import of frontmatter.ts is redirected to a minimal local shim because the checkout
 * has no node_modules (see loader.mjs / yaml-shim.mjs).
 *
 * Run:
 *   node --import ./.prale-eval/demo/register-loader.mjs ./.prale-eval/demo/run-demo.mjs
 *
 * Output: deterministic JSON (stable key order, no timestamps) on stdout and in
 * .prale-eval/demo-output.json.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const demoDir = fileURLToPath(new URL(".", import.meta.url));
const root = join(demoDir, "..", "..");
const ingestDir = join(root, "MemoryKnowledge/src/engines/wiki/ingest-v2");
const corpusDir = join(demoDir, "corpus");

const { slugify, dirForType, pageRelPath } = await import(join(ingestDir, "slug.ts"));
const { parseFrontmatter, buildPage, isLocked, readSources } = await import(join(ingestDir, "frontmatter.ts"));
const { chunkText, estimateTokens } = await import(join(ingestDir, "chunker.ts"));

/** Production budget used by ingest/index.ts before it splits a source. */
const SOURCE_CHAR_BUDGET = 28_000;
/** Small target so the chunker is observable on a small corpus (chunker clamps to >= 1000). */
const DEMO_TARGET_CHARS = 1_000;

const shortHash = (s) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 12);

function ingestDoc(file) {
  const content = readFileSync(file, "utf-8");
  const sourceName = basename(file);
  const { frontmatter, body, hasFrontmatter } = parseFrontmatter(content);

  const type = typeof frontmatter.type === "string" && frontmatter.type ? frontmatter.type : "other";
  // Same fallback the index builder uses: frontmatter.title, else the file name.
  const title =
    typeof frontmatter.title === "string" && frontmatter.title.trim()
      ? frontmatter.title.trim()
      : sourceName.replace(/\.md$/, "");

  const slug = slugify(title);
  // Canonical dedup key == document id (slug.ts:pageRelPath / index.ts:canonicalizePagePath).
  const docId = pageRelPath(type, title);

  const demoChunks = chunkText(body, { targetChars: DEMO_TARGET_CHARS });
  const budgetChunks = chunkText(body, { targetChars: SOURCE_CHAR_BUDGET });

  // Round-trip: rebuild the page from its parsed frontmatter and read it back.
  // buildPage() re-emits `---\n<yaml>\n---\n\n<cleanBody>\n`, so the re-parsed body
  // is "\n" + cleanBody + "\n" with cleanBody = body trimmed of surrounding whitespace.
  const rebuilt = buildPage(frontmatter, body);
  const reread = parseFrontmatter(rebuilt);
  const cleanBody = body.replace(/^\s+/, "").replace(/\s+$/, "");

  return {
    source: sourceName,
    contentId: shortHash(content),
    hasFrontmatter,
    type,
    title,
    slug,
    dir: dirForType(type),
    docId,
    locked: isLocked(content),
    sources: readSources(content),
    bodyChars: body.length,
    estimatedTokens: estimateTokens(body),
    chunkCountAtDemoTarget: demoChunks.length,
    chunkCountAtProductionBudget: budgetChunks.length,
    chunkLengths: demoChunks.map((c) => c.length),
    roundTrip: {
      hasFrontmatterAfterRebuild: reread.hasFrontmatter,
      typePreserved: reread.frontmatter.type === type,
      titlePreserved: reread.frontmatter.title === frontmatter.title,
      tagsPreserved: JSON.stringify(reread.frontmatter.tags ?? null) === JSON.stringify(frontmatter.tags ?? null),
      sourcesPreserved: JSON.stringify(reread.frontmatter.sources ?? null) === JSON.stringify(frontmatter.sources ?? null),
      bodyPreserved: reread.body.trim() === cleanBody,
    },
  };
}

function run() {
  const files = readdirSync(corpusDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => join(corpusDir, f));

  const documents = files.map(ingestDoc);

  // Chunking invariants on the longest source.
  const longest = documents.reduce((a, b) => (b.bodyChars > a.bodyChars ? b : a));
  const longestBody = parseFrontmatter(readFileSync(join(corpusDir, longest.source), "utf-8")).body;
  const chunks = chunkText(longestBody, { targetChars: DEMO_TARGET_CHARS });

  const checks = {
    everyDocHasDocId: documents.every((d) => d.docId.startsWith("wiki/") && d.docId.endsWith(".md")),
    everyDocRoundTrips: documents.every(
      (d) =>
        d.roundTrip.typePreserved &&
        d.roundTrip.titlePreserved &&
        d.roundTrip.tagsPreserved &&
        d.roundTrip.sourcesPreserved &&
        d.roundTrip.bodyPreserved,
    ),
    everyChunkWithinTarget: chunks.every((c) => c.length <= DEMO_TARGET_CHARS),
    // chunker.ts seeds each chunk with the previous chunk's last `overlap` chars + "\n\n".
    overlapSeeded: chunks.slice(1).every((c, i) => c.startsWith(chunks[i].slice(-400) + "\n\n")),
    emptyInputYieldsNoChunks: chunkText("   ").length === 0,
    shortInputYieldsSingleChunk: chunkText("# tiny").length === 1,
    repeatedRunIdentical: true, // filled in by the caller
  };

  return {
    demo: "wiki-ingest helpers on a local markdown corpus",
    helpers: {
      slug: "MemoryKnowledge/src/engines/wiki/ingest-v2/slug.ts",
      frontmatter: "MemoryKnowledge/src/engines/wiki/ingest-v2/frontmatter.ts",
      chunker: "MemoryKnowledge/src/engines/wiki/ingest-v2/chunker.ts",
    },
    corpus: { dir: ".prale-eval/demo/corpus", files: files.map((f) => basename(f)) },
    documentCount: documents.length,
    totalChunksAtDemoTarget: documents.reduce((n, d) => n + d.chunkCountAtDemoTarget, 0),
    totalChunksAtProductionBudget: documents.reduce((n, d) => n + d.chunkCountAtProductionBudget, 0),
    documents,
    chunkingInvariants: {
      source: longest.source,
      targetChars: DEMO_TARGET_CHARS,
      overlapChars: 400,
      chunkCount: chunks.length,
      chunkLengths: chunks.map((c) => c.length),
      ...checks,
    },
  };
}

// Deterministic: two independent runs must serialize identically.
const first = JSON.stringify(run(), null, 2);
const second = JSON.stringify(run(), null, 2);
const out = JSON.parse(first);
out.deterministicAcrossRuns = first === second;
out.chunkingInvariants.repeatedRunIdentical = first === second;

const failed = Object.entries(out.chunkingInvariants).filter(([, v]) => v === false).map(([k]) => k);
out.allChecksPassed = failed.length === 0;
out.failedChecks = failed;

const text = JSON.stringify(out, null, 2) + "\n";
writeFileSync(join(demoDir, "..", "demo-output.json"), text);
process.stdout.write(text);
if (!out.allChecksPassed) {
  process.stderr.write(`demo checks failed: ${failed.join(", ")}\n`);
  process.exitCode = 1;
}
