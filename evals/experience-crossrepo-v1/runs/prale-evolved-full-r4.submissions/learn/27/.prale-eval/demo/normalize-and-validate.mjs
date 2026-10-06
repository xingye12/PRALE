#!/usr/bin/env node
/**
 * normalize-and-validate.mjs — executable, dependency-free demo for task learn/27.
 *
 * Goal (TASK.md): "normalize markdown/frontmatter input before indexing and
 * reject malformed metadata."
 *
 * The demo mirrors, without importing, two repository contracts that bound the
 * ingest path. Imports are avoided only because this checkout has no
 * node_modules (the real frontmatter parser needs the `yaml` package); the
 * behavior below is line-referenced to the source it mirrors:
 *
 *   MemoryKnowledge/src/engines/code/normalize.ts
 *     - normalizeRepoUrl (L13-L35): SSH / HTTPS / bare git URL -> `host/path`
 *       with the `.git` suffix stripped; already-normalized input passes through.
 *     - sourceKey       (L40-L42): `${normalizeRepoUrl(repo)}:${branch || "main"}`
 *       — the stable per-datasource index key.
 *
 *   MemoryKnowledge/src/engines/wiki/ingest-v2/frontmatter.ts
 *     - FM_RE            (L36):     /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/
 *     - parseFrontmatter (L42-L62): tolerant split of page -> frontmatter + body.
 *       Bad / missing YAML silently degrades to `{ type: "other" }`.
 *     - buildPage        (L85-L101): canonical field order
 *       (type -> title -> description -> sources -> tags -> timestamp -> extras),
 *       trims the body, and never writes `locked`.
 *
 * The task adds the missing half of that contract: BEFORE indexing we
 * NORMALIZE the markdown, and REJECT malformed metadata with a descriptive,
 * typed error instead of the silent `type:"other"` downgrade.
 *
 * Run:  node .prale-eval/demo/normalize-and-validate.mjs
 * Exit: 0 all assertions pass, 1 otherwise. Prints a JSON operation report.
 */

// ---------------------------------------------------------------------------
// Typed rejection error — the "reject malformed metadata" contract.
// ---------------------------------------------------------------------------
import { pathToFileURL } from "node:url";

export class MetadataError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "MetadataError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Mirror of MemoryKnowledge/src/engines/code/normalize.ts (L13-L42)
// ---------------------------------------------------------------------------
export function normalizeRepoUrl(input) {
  const raw = String(input ?? "").trim();
  if (!raw) throw new MetadataError("EMPTY_REPO_URL", "repo url must be a non-empty string");

  // SSH: git@host:path.git  (or ssh://git@host/path.git)
  const sshMatch = raw.match(/^(?:ssh:\/\/)?(?:\w+@)([^:/]+)[:/](.+?)(?:\.git)?$/);
  if (sshMatch) return `${sshMatch[1]}/${sshMatch[2].replace(/\.git$/, "")}`;

  // HTTPS: https://host/path.git
  const httpsMatch = raw.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/);
  if (httpsMatch) return `${httpsMatch[1]}/${httpsMatch[2].replace(/\.git$/, "")}`;

  // Already normalized (host/namespace/project) -> pass-through, strip .git.
  return raw.replace(/\.git$/, "");
}

export function sourceKey(repo, branch) {
  return `${normalizeRepoUrl(repo)}:${branch || "main"}`;
}

// ---------------------------------------------------------------------------
// Mirror of frontmatter.ts FM_RE (L36) + a strict subset YAML reader.
// The strict reader is what lets us REJECT malformed metadata; the real parser
// swallows the same input and downgrades to type:"other".
// ---------------------------------------------------------------------------
const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

const FIELD_ORDER = ["type", "title", "description", "sources", "tags", "timestamp"];

const TYPE_DIR = {
  source: "sources",
  entity: "entities",
  concept: "concepts",
  comparison: "comparisons",
  synthesis: "synthesis",
  thesis: "synthesis",
  methodology: "concepts",
  finding: "synthesis",
  overview: "overview",
};

function dirForType(type) {
  return TYPE_DIR[type] ?? "other";
}

function slugify(input) {
  const text = String(input ?? "").trim();
  if (!text) return "";
  // CJK kept verbatim, latin lowercased, everything else a token boundary.
  const tokens = text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+|[A-Za-z0-9]+/g) ?? [];
  return tokens.map((t) => (/^[A-Za-z0-9]+$/.test(t) ? t.toLowerCase() : t)).join("-");
}

function parseScalar(token, lineNo) {
  if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) {
    return JSON.parse(token);
  }
  if (token.length >= 2 && token.startsWith("'") && token.endsWith("'")) {
    return token.slice(1, -1).replace(/''/g, "'");
  }
  if (token.startsWith("[") || token.endsWith("]")) {
    if (!(token.startsWith("[") && token.endsWith("]"))) {
      throw new MetadataError("MALFORMED_YAML", `unbalanced flow sequence on line ${lineNo}: ${token}`);
    }
    const inner = token.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((part) => parseScalar(part.trim(), lineNo));
  }
  if (token.startsWith('"') || token.startsWith("'")) {
    throw new MetadataError("MALFORMED_YAML", `unterminated quoted string on line ${lineNo}: ${token}`);
  }
  if (token === "true") return true;
  if (token === "false") return false;
  if (token === "null" || token === "~") return null;
  return token;
}

function parseYamlSubset(yamlText) {
  const out = {};
  let pendingKey = null;
  let pendingList = null;

  const lines = String(yamlText).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    if (line.includes("\t")) {
      throw new MetadataError("MALFORMED_YAML", `tab characters are not allowed on line ${lineNo}`);
    }
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    // Block-sequence items may be indented under their parent key.
    if (/^\s*-\s/.test(line)) {
      if (!pendingKey) {
        throw new MetadataError("MALFORMED_YAML", `list item without a parent key on line ${lineNo}`);
      }
      pendingList.push(parseScalar(trimmed.slice(2).trim(), lineNo));
      continue;
    }
    if (/^\s/.test(line)) {
      throw new MetadataError("MALFORMED_YAML", `unexpected indentation on line ${lineNo}`);
    }
    const idx = line.indexOf(":");
    if (idx <= 0) {
      throw new MetadataError("MALFORMED_YAML", `expected "key: value" on line ${lineNo}: ${line}`);
    }
    const key = line.slice(0, idx).trim();
    const rest = line.slice(idx + 1).trim();
    if (!/^[A-Za-z_][\w.-]*$/.test(key)) {
      throw new MetadataError("MALFORMED_YAML", `invalid key on line ${lineNo}: ${key}`);
    }
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      throw new MetadataError("MALFORMED_YAML", `duplicate key on line ${lineNo}: ${key}`);
    }
    if (rest === "") {
      pendingKey = key;
      pendingList = [];
      out[key] = pendingList;
    } else {
      pendingKey = null;
      pendingList = null;
      out[key] = parseScalar(rest, lineNo);
    }
  }
  return out;
}

function normalizeStringList(value, field) {
  const items = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of items) {
    if (typeof item !== "string") {
      throw new MetadataError("INVALID_FIELD", `'${field}' entries must be strings`);
    }
    const text = item.trim();
    if (text && !out.includes(text)) out.push(text);
  }
  return out;
}

function stringifyScalar(value) {
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return `[${value.map(stringifyScalar).join(", ")}]`;
  const text = String(value);
  return /^[A-Za-z0-9_./@+-]+$/.test(text) ? text : JSON.stringify(text);
}

// Mirror of buildPage L85-L101: fixed field order, no `locked` field.
export function buildPage(frontmatter, body) {
  const ordered = {};
  for (const key of FIELD_ORDER) {
    if (frontmatter[key] != null) ordered[key] = frontmatter[key];
  }
  for (const [key, value] of Object.entries(frontmatter)) {
    if (key in ordered || key === "locked" || value == null) continue;
    ordered[key] = value;
  }
  const yaml = Object.entries(ordered)
    .map(([key, value]) => `${key}: ${stringifyScalar(value)}`)
    .join("\n");
  const cleanBody = String(body ?? "").replace(/^\s+/, "").replace(/\s+$/, "");
  return `---\n${yaml}\n---\n\n${cleanBody}\n`;
}

/**
 * Normalize markdown/frontmatter input before indexing.
 * Throws MetadataError (with a machine-readable `code`) on malformed metadata;
 * the caller must refuse to index anything that throws.
 */
export function normalizeMarkdown(input) {
  const text = String(input ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const match = text.match(FM_RE);
  if (!match) {
    throw new MetadataError("MISSING_FRONTMATTER", "page has no leading `---` frontmatter block");
  }

  const yamlText = match[1];
  const body = text.slice(match[0].length);
  const parsed = parseYamlSubset(yamlText);

  const type = parsed.type;
  if (typeof type !== "string" || !type.trim()) {
    throw new MetadataError("INVALID_TYPE", "'type' is required and must be a non-empty string");
  }

  const frontmatter = { type: type.trim() };

  for (const key of ["title", "description", "timestamp"]) {
    const value = parsed[key];
    if (value == null || value === "") continue;
    if (typeof value !== "string") {
      throw new MetadataError("INVALID_FIELD", `'${key}' must be a string`);
    }
    frontmatter[key] = value.trim();
  }

  for (const key of ["sources", "tags"]) {
    if (!(key in parsed)) continue;
    frontmatter[key] = normalizeStringList(parsed[key], key);
  }

  // Pass through unknown fields (OKF tolerant consumption); `locked` is dropped
  // exactly like buildPage does — produced pages never carry it.
  for (const [key, value] of Object.entries(parsed)) {
    if (FIELD_ORDER.includes(key) || key === "locked" || value == null) continue;
    frontmatter[key] = value;
  }

  return { frontmatter, body, markdown: buildPage(frontmatter, body) };
}

/**
 * One normalized indexing operation: normalize the datasource key AND the page,
 * or reject the whole unit. Returns the normalized record an indexer would store.
 */
export function normalizeAndIndexEntry({ repo, branch, markdown }) {
  const key = sourceKey(repo, branch); // rejects empty repo url
  const page = normalizeMarkdown(markdown); // rejects malformed metadata
  const title = page.frontmatter.title ?? page.frontmatter.type;
  const slug = slugify(title) || slugify(page.frontmatter.type) || "page";
  const path = `wiki/${dirForType(page.frontmatter.type)}/${slug}.md`;
  return {
    sourceKey: key,
    path,
    frontmatter: page.frontmatter,
    body: page.body,
    markdown: page.markdown,
  };
}

// ---------------------------------------------------------------------------
// Demo scenario table (executable contract cases).
// ---------------------------------------------------------------------------
const REPO_FORMS = [
  "git@gitlab.example.com:namespace/project/repo.git",
  "https://gitlab.example.com/namespace/project/repo.git",
  "gitlab.example.com/namespace/project/repo",
];

const VALID_PAGE = [
  "---",
  "type: entity",
  "title:   Redis Cluster  ",
  "description: Redis 主从拓扑",
  "sources:",
  "  - design.md",
  "  - redis.md",
  "  - design.md", // duplicate -> normalized away
  "tags: [cache, redis]",
  "locked: true", // must NOT survive normalization
  "custom_field: kept",
  "---",
  "",
  "   Redis Cluster 使用分片。   ",
  "",
].join("\n");

const CASES = [
  {
    name: "valid_page_is_normalized",
    repo: REPO_FORMS[0],
    branch: "main",
    markdown: VALID_PAGE,
    expect: "ok",
  },
  {
    name: "crlf_frontmatter_is_normalized",
    repo: "https://gitlab.example.com/namespace/project/repo.git",
    branch: "",
    markdown: "---\r\ntype: concept\r\ntitle: Vector Index\r\n---\r\n\r\nBody text.\r\n",
    expect: "ok",
  },
  {
    name: "scalar_sources_is_coerced",
    repo: REPO_FORMS[2],
    branch: "release/1.0",
    markdown: "---\ntype: entity\ntitle: Solo\nsources: design.md\n---\nBody.\n",
    expect: "ok",
  },
  {
    name: "missing_frontmatter_is_rejected",
    repo: REPO_FORMS[0],
    branch: "main",
    markdown: "# No frontmatter\n\nBody only.\n",
    expect: "reject",
    code: "MISSING_FRONTMATTER",
  },
  {
    name: "malformed_yaml_duplicate_key_is_rejected",
    repo: REPO_FORMS[0],
    branch: "main",
    markdown: "---\ntype: entity\ntype: concept\n---\nBody.\n",
    expect: "reject",
    code: "MALFORMED_YAML",
  },
  {
    name: "malformed_yaml_unterminated_quote_is_rejected",
    repo: REPO_FORMS[0],
    branch: "main",
    markdown: '---\ntype: entity\ntitle: "Broken\n---\nBody.\n',
    expect: "reject",
    code: "MALFORMED_YAML",
  },
  {
    name: "blank_type_is_rejected",
    repo: REPO_FORMS[0],
    branch: "main",
    markdown: "---\ntype:   \ntitle: No Type\n---\nBody.\n",
    expect: "reject",
    code: "INVALID_TYPE",
  },
  {
    name: "non_string_sources_entry_is_rejected",
    repo: REPO_FORMS[0],
    branch: "main",
    markdown: "---\ntype: entity\ntitle: Bad Sources\nsources: [[nested]]\n---\nBody.\n",
    expect: "reject",
    code: "INVALID_FIELD",
  },
  {
    name: "empty_repo_url_is_rejected",
    repo: "   ",
    branch: "main",
    markdown: VALID_PAGE,
    expect: "reject",
    code: "EMPTY_REPO_URL",
  },
];

function runCase(testCase) {
  try {
    const entry = normalizeAndIndexEntry({
      repo: testCase.repo,
      branch: testCase.branch,
      markdown: testCase.markdown,
    });
    const result = {
      case: testCase.name,
      outcome: "indexed",
      sourceKey: entry.sourceKey,
      path: entry.path,
      frontmatter: entry.frontmatter,
      hasLockedField: /^locked:/m.test(entry.markdown),
    };
    const pass = testCase.expect === "ok";
    return { pass, result, failure: pass ? null : "expected rejection but page was indexed" };
  } catch (err) {
    const code = err instanceof MetadataError ? err.code : "UNEXPECTED_ERROR";
    const result = { case: testCase.name, outcome: "rejected", code, message: err.message };
    const pass = testCase.expect === "reject" && code === testCase.code;
    return { pass, result, failure: pass ? null : `expected ${testCase.expect}(${testCase.code ?? ""}) got ${code}` };
  }
}

function main() {
  const report = { task: "learn/27", demo: "normalize markdown/frontmatter before indexing", cases: [] };
  let failures = 0;

  // 1) URL normalization: all three spellings collapse to one index key.
  const keys = new Set(REPO_FORMS.map((form) => sourceKey(form, "main")));
  const urlCheck = {
    case: "repo_url_forms_collapse_to_one_source_key",
    outcome: keys.size === 1 ? "passed" : "failed",
    keys: [...keys],
    pass: keys.size === 1,
  };
  if (!urlCheck.pass) failures++;
  report.cases.push(urlCheck);

  // 2) Contract cases.
  for (const testCase of CASES) {
    const { pass, result, failure } = runCase(testCase);
    if (!pass) failures++;
    report.cases.push({ ...result, pass, ...(failure ? { failure } : {}) });
  }

  report.summary = {
    total: report.cases.length,
    passed: report.cases.filter((c) => c.pass).length,
    failed: failures,
  };
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = failures === 0 ? 0 : 1;
}

// Allow `import` from a harness without executing the demo.
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();

export { CASES, REPO_FORMS, VALID_PAGE, runCase };
