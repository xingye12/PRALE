/**
 * normalize-contract.mjs — executable contract for the wiki ingest normalization.
 *
 * Runs the REAL repository modules (no re-implementation) over the synthetic
 * corpus in corpus.mjs and proves two things:
 *   1. normalization is DETERMINISTIC  (same corpus -> byte-identical manifest,
 *      and result is independent of input order); duplicate headings collapse
 *      onto a single slug / page path, so a second ingest hits the same file.
 *   2. invalid metadata is handled EXPLICITLY, never by throwing: malformed or
 *      missing frontmatter resolves to the sentinel type "other" -> the explicit
 *      `wiki/other/...` directory, with `hasFrontmatter` reporting what happened.
 *
 * Modules under test (real, unmodified):
 *   MemoryKnowledge/src/engines/wiki/ingest-v2/slug.ts        (slugify/dirForType/pageRelPath)
 *   MemoryKnowledge/src/engines/wiki/ingest-v2/frontmatter.ts (parseFrontmatter/buildPage)
 *
 * frontmatter.ts imports the third-party `yaml` package, which is not installed
 * here; register.mjs maps that specifier to a labelled minimal test double so
 * the real code paths execute. See yaml-shim.mjs for scope and limits.
 *
 * Run:
 *   node --import ./.prale-eval/demo/register.mjs \
 *        ./.prale-eval/demo/normalize-contract.mjs
 * Exit code 0 = contract holds; 1 = a proof failed (details printed).
 */

import { createHash } from "node:crypto";
import { slugify, dirForType, pageRelPath } from "../../MemoryKnowledge/src/engines/wiki/ingest-v2/slug.ts";
import { parseFrontmatter, buildPage } from "../../MemoryKnowledge/src/engines/wiki/ingest-v2/frontmatter.ts";
import { CORPUS, DUP_GROUP_A, DUP_GROUP_B, INVALID } from "./corpus.mjs";

const failures = [];
const check = (name, cond, detail = "") => {
  if (!cond) failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
  return cond;
};

/** The normalization step under contract: raw page -> stable identity. */
function normalize(page) {
  const parsed = parseFrontmatter(page.raw);           // tolerant, never throws
  const fmTitle = parsed.frontmatter.title;
  const title = typeof fmTitle === "string" && fmTitle.trim() ? fmTitle.trim() : page.heading;
  const type = parsed.frontmatter.type;                // parseFrontmatter guarantees a non-empty string
  return {
    id: page.id,
    title,
    type,
    hasFrontmatter: parsed.hasFrontmatter,
    slug: slugify(title),
    dir: dirForType(type),
    relPath: pageRelPath(type, title),
  };
}

const manifest = CORPUS.map(normalize);
const json = (x) => JSON.stringify(x, null, 0);

// ---- PROOF 1: determinism --------------------------------------------------
const again = CORPUS.map(normalize);
check("deterministic: repeated run is byte-identical", json(manifest) === json(again));
check("deterministic: slugify is a pure function",
  CORPUS.every((p) => slugify(p.heading) === slugify(p.heading)));

const reversed = [...CORPUS].reverse().map(normalize);
const sortedById = (rows) => rows.map((r) => json(r)).sort();
check("deterministic: independent of input order", json(sortedById(manifest)) === json(sortedById(reversed)));

const digest = createHash("sha256").update(json(manifest)).digest("hex");

// ---- PROOF 2: duplicate headings collapse onto one identity ----------------
// The slug is the dedup key; the page path pairs that slug with the type dir.
const groupBy = (rows, key) => {
  const m = new Map();
  for (const r of rows) m.set(r[key], [...(m.get(r[key]) ?? []), r.id].sort());
  return [...m.entries()].filter(([, ids]) => ids.length > 1).map(([k, ids]) => ({ key: k, ids }));
};
const slugCollapsed = groupBy(manifest, "slug");
const pathCollapsed = groupBy(manifest, "relPath");

check("dedup: group A (5 surface forms) collapses to ONE slug",
  slugCollapsed.some((c) => c.key === "redis-主从复制" && json(c.ids) === json([...DUP_GROUP_A].sort())),
  json(slugCollapsed));
check("dedup: group B (2 surface forms) collapses to ONE slug",
  slugCollapsed.some((c) => c.key === "kafka-consumer-lag" && json(c.ids) === json([...DUP_GROUP_B].sort())));
// The 4 group-A members that carry a well-formed type:entity land on one page path.
check("dedup: group A valid-type members share ONE page path",
  ["runbook-a1", "runbook-a2", "runbook-a3", "runbook-a5"]
    .every((id) => manifest.find((r) => r.id === id).relPath === "wiki/entities/redis-主从复制.md"));
check("dedup: group B collapses to ONE page path",
  pathCollapsed.some((c) => c.key === "wiki/concepts/kafka-consumer-lag.md" && json(c.ids) === json([...DUP_GROUP_B].sort())),
  json(pathCollapsed));
// The explicit consequence of malformed metadata: same heading, different dir.
check("dedup: group A's no-frontmatter member diverges to the explicit other/ dir",
  manifest.find((r) => r.id === "runbook-a4").relPath === "wiki/other/redis-主从复制.md");

// ---- PROOF 3: invalid metadata handled explicitly --------------------------
const invalidRows = manifest.filter((r) => INVALID.includes(r.id));
check("invalid: every malformed page resolves to the sentinel type 'other'",
  invalidRows.every((r) => r.type === "other"), json(invalidRows));
check("invalid: every malformed page lands in the explicit wiki/other/ dir",
  invalidRows.every((r) => r.relPath.startsWith("wiki/other/")), json(invalidRows));
check("invalid: parseFrontmatter flags the unparseable/missing cases",
  manifest.find((r) => r.id === "bad-nofm").hasFrontmatter === false &&
  manifest.find((r) => r.id === "bad-flow").hasFrontmatter === false &&
  manifest.find((r) => r.id === "bad-line").hasFrontmatter === false);
check("invalid: non-string / blank type is coerced to 'other' but block is recognised",
  manifest.find((r) => r.id === "bad-typenum").hasFrontmatter === true &&
  manifest.find((r) => r.id === "bad-typenum").type === "other" &&
  manifest.find((r) => r.id === "bad-typeblank").type === "other");
check("invalid: unknown-but-well-formed type is preserved (no false fallback)",
  manifest.find((r) => r.id === "unknown-type").type === "playbook" &&
  manifest.find((r) => r.id === "unknown-type").relPath === "wiki/playbook/playbook-foo.md");

// ---- PROOF 4: round-trip is stable (buildPage normalizes) -------------------
const first = manifest.find((r) => r.id === "runbook-b1");
const round = parseFrontmatter(buildPage({ type: first.type, title: first.title }, "body"));
check("round-trip: buildPage emits parseable frontmatter with the same identity",
  round.hasFrontmatter === true && round.frontmatter.type === first.type &&
  pageRelPath(round.frontmatter.type, round.frontmatter.title) === first.relPath,
  `type=${round.frontmatter.type} title=${round.frontmatter.title}`);

// ---- report ----------------------------------------------------------------
const report = {
  corpusSize: CORPUS.length,
  manifestDigest: digest,
  collapsedBySlug: slugCollapsed,
  collapsedByPath: pathCollapsed,
  manifest,
  checks: failures.length === 0 ? "PASS" : "FAIL",
  failures,
};
console.log(JSON.stringify(report, null, 2));
process.exit(failures.length === 0 ? 0 : 1);
