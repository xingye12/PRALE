/**
 * corpus.mjs — a DIFFERENT corpus, synthetic and unrelated to this repo's own
 * wiki fixtures: an observability runbook bundle. It is deliberately built with
 *   (a) duplicate headings  — the same entity written many different ways, and
 *   (b) malformed frontmatter — every failure mode `parseFrontmatter` must survive.
 *
 * `heading` is what an ingest would read off the page's first `#` line; it is the
 * title fed to `slugify` / `pageRelPath`. `raw` is the on-disk page content.
 */
export const CORPUS = [
  // ---- duplicate-heading group A: same entity, 5 surface forms ----------------
  {
    id: "runbook-a1",
    heading: "Redis 主从复制",
    raw: `---\ntype: entity\ntitle: Redis 主从复制\n---\n\nPrimary/replica topology for the cache tier.`,
  },
  {
    id: "runbook-a2",
    heading: "redis 主从复制",
    raw: `---\ntype: ENTITY\ntitle: redis 主从复制\n---\n\nLower-cased restatement of the same page.`,
  },
  {
    id: "runbook-a3",
    heading: "Redis  主从复制!",
    raw: `---\ntype: entity\ntitle: "Redis  主从复制!"\n---\n\nPunctuation + doubled space variant.`,
  },
  {
    id: "runbook-a4",
    heading: "Redis-主从复制",
    raw: `no frontmatter at all on this duplicate`,
  },
  {
    id: "runbook-a5",
    heading: "  Redis 主从复制  ",
    raw: `---\ntype: entity\ntitle: "  Redis 主从复制  "\n---\n\nSurrounding-whitespace variant.`,
  },

  // ---- duplicate-heading group B: latin/CJK mix ------------------------------
  {
    id: "runbook-b1",
    heading: "Kafka Consumer Lag",
    raw: `---\ntype: concept\ntitle: Kafka Consumer Lag\n---\n\nDetecting backlog on the event bus.`,
  },
  {
    id: "runbook-b2",
    heading: "kafka  consumer   lag",
    raw: `---\ntype: concept\ntitle: kafka  consumer   lag\n---\n\nSame concept, messy whitespace.`,
  },

  // ---- malformed frontmatter: no FM block ------------------------------------
  {
    id: "bad-nofm",
    heading: "Bare Procedure",
    raw: `# Bare Procedure\n\nJust a body, no frontmatter delimiter at all.`,
  },
  // ---- malformed frontmatter: unterminated flow sequence ---------------------
  {
    id: "bad-flow",
    heading: "Broken Tags",
    raw: `---\ntype: source\ntags: [redis, cache\n---\n\nUnterminated flow sequence.`,
  },
  // ---- malformed frontmatter: not a flat mapping -----------------------------
  {
    id: "bad-line",
    heading: "Garbage Header",
    raw: `---\ntype: source\nthis line is not yaml\n---\n\nBody that must survive.`,
  },
  // ---- malformed metadata: type is a non-string scalar -----------------------
  {
    id: "bad-typenum",
    heading: "Numeric Type",
    raw: `---\ntype: 123\ntitle: Numeric Type\n---\n\nType field is not a string.`,
  },
  // ---- malformed metadata: blank string type ---------------------------------
  {
    id: "bad-typeblank",
    heading: "Blank Type",
    raw: `---\ntype: "   "\ntitle: Blank Type\n---\n\nType field is whitespace only.`,
  },
  // ---- unknown (but well-formed) type ----------------------------------------
  {
    id: "unknown-type",
    heading: "Playbook Foo",
    raw: `---\ntype: playbook\ntitle: Playbook Foo\n---\n\nA type the dir map has never seen.`,
  },
];

/** The 5 surface forms in group A that MUST collapse to one slug/path. */
export const DUP_GROUP_A = ["runbook-a1", "runbook-a2", "runbook-a3", "runbook-a4", "runbook-a5"];
/** The 2 surface forms in group B that MUST collapse to one slug/path. */
export const DUP_GROUP_B = ["runbook-b1", "runbook-b2"];
/** Pages whose metadata is invalid and must resolve to the explicit fallback. */
export const INVALID = ["bad-nofm", "bad-flow", "bad-line", "bad-typenum", "bad-typeblank"];
