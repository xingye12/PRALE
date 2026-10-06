#!/usr/bin/env node
/**
 * normalize.mjs — T03 contract demo (repository key: tdam, mode: contract)
 * ---------------------------------------------------------------------------
 * "Contract a different corpus containing duplicate headings and malformed
 *  frontmatter; prove normalization is deterministic and invalid metadata is
 *  handled explicitly."
 *
 * What this script does
 *   1. Reads a corpus that is NOT the wiki corpus under contract
 *      (`.prale-eval/corpus/*.md`, derived from the repo's docs/ + agents/
 *      documentation corpus: docs/tdai-v2-technical-ops.md, agents/<agent>/
 *      asset-import.md, agents/<agent>/README.md).
 *   2. Normalizes every page with the repository's real, unmodified symbols
 *      `slugify`, `dirForType`, `pageRelPath` imported straight from
 *      MemoryKnowledge/src/engines/wiki/ingest-v2/slug.ts (single source of
 *      truth — no re-implementation of the slug rules here).
 *   3. Mirrors the tolerant frontmatter contract of ingest-v2/frontmatter.ts
 *      (parseFrontmatter / readSources) but, unlike the library, never lets an
 *      invalid block pass silently: every malformed input produces a stable
 *      diagnostic code plus the explicit fallback that was applied.
 *   4. Assigns deterministic anchors for duplicate headings (per normalized
 *      page, in file-path then line order) and deterministic path suffixes for
 *      cross-file page collisions.
 *   5. Emits `out/normalization-report.json` and `out/wiki-index.md`, and with
 *      `--check` proves: idempotent slugify, three identical in-process runs,
 *      byte-identical output versus the previous process run, one explicit
 *      diagnostic per malformed page, and unique anchors per page.
 *
 * Determinism notes
 *   - No timestamps / random / locale-dependent ordering anywhere in the
 *     report. Comparisons use code-point order (`<`), never localeCompare.
 *   - Corpus files are read fresh for every run, so the digest also covers
 *     "same bytes in → same bytes out" across processes.
 *
 * Usage:  node .prale-eval/normalize.mjs [--check]
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

// Real symbols under contract (Node >= 22.6 strips the TS types natively).
import { dirForType, pageRelPath, slugify } from "../MemoryKnowledge/src/engines/wiki/ingest-v2/slug.ts";

const HERE = fileURLToPath(new URL(".", import.meta.url)); // .../.prale-eval/
const CORPUS_DIR = join(HERE, "corpus");
const OUT_DIR = join(HERE, "out");
const REPORT_PATH = join(OUT_DIR, "normalization-report.json");
const INDEX_PATH = join(OUT_DIR, "wiki-index.md");

const CHECK = process.argv.includes("--check");

/** Stable diagnostic vocabulary. Every code carries the explicit fallback. */
const CODES = {
  FM_ABSENT: "没有 frontmatter 块 → type=other，title 取文件 basename",
  FM_UNTERMINATED: "起始 `---` 后找不到闭合 `---` → 整块元数据丢弃，type=other",
  FM_INVALID_YAML: "块内 YAML 非法（本子集解析失败）→ 整块元数据丢弃，type=other",
  FM_NOT_MAPPING: "frontmatter 根节点不是映射 → 整块元数据丢弃，type=other",
  FM_DUPLICATE_KEY: "frontmatter 内重复键 → 整块元数据丢弃，type=other",
  FM_TYPE_INVALID: "type 缺失/空/非字符串 → type=other",
  FM_TITLE_FALLBACK: "title 缺失/空/非字符串 → title 取文件 basename",
  FM_SOURCES_NOT_ARRAY: "sources 不是数组 → sources=[]",
  FM_SOURCES_NON_STRING: "sources 里含非字符串条目 → 逐条丢弃并计数",
  PAGE_PATH_COLLISION: "多个文件归一到同一页路径 → 按文件路径序保留首个，其余加 `-N` 后缀",
  HEADING_SLUG_EMPTY: "标题归一化后为空 → 跳过该标题并记录",
  HEADING_DUPLICATE: "同页锚点已存在 → 追加确定性的 `-N` 后缀",
};

// ---------------------------------------------------------------------------
// deterministic helpers
// ---------------------------------------------------------------------------

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
/** Code-point ordering: identical on every machine / locale. */
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readCorpus() {
  return readdirSync(CORPUS_DIR)
    .filter((n) => n.endsWith(".md"))
    .sort(cmp)
    .map((name) => {
      const text = readFileSync(join(CORPUS_DIR, name), "utf-8");
      return { file: `.prale-eval/corpus/${name}`, name, text, digest: sha256(text) };
    });
}

// ---------------------------------------------------------------------------
// frontmatter: tolerant parse (contract mirror of ingest-v2/frontmatter.ts)
// ---------------------------------------------------------------------------

function parseScalar(raw, line) {
  const t = raw.trim();
  if (t === "") return { ok: true, value: null };
  if (t.startsWith('"') || t.startsWith("'")) {
    const q = t[0];
    if (t.length < 2 || !t.endsWith(q)) {
      return { ok: false, line, detail: `引号未闭合的标量: ${JSON.stringify(raw)}` };
    }
    return { ok: true, value: t.slice(1, -1) };
  }
  if (t === "true") return { ok: true, value: true };
  if (t === "false") return { ok: true, value: false };
  if (t === "null" || t === "~") return { ok: true, value: null };
  if (/^-?\d+$/.test(t)) return { ok: true, value: Number(t) };
  if (/^[[\]{}!&*|>@%`]/.test(t)) {
    return { ok: false, line, detail: `本子集不支持的标量语法: ${JSON.stringify(raw)}` };
  }
  return { ok: true, value: t };
}

function parseFlowSeq(raw, line) {
  const t = raw.trim();
  if (!t.endsWith("]")) {
    return { ok: false, line, detail: `流式序列未闭合（缺少 ']'）: ${JSON.stringify(raw)}` };
  }
  const inner = t.slice(1, -1);
  if (inner.includes("[") || inner.includes("]")) {
    return { ok: false, line, detail: `不支持的嵌套流式序列: ${JSON.stringify(raw)}` };
  }
  const items = [];
  for (const piece of inner.split(",")) {
    if (piece.trim() === "") continue;
    const s = parseScalar(piece, line);
    if (!s.ok) return s;
    items.push(s.value);
  }
  return { ok: true, value: items };
}

/**
 * Line-based YAML subset parser, sufficient for the corpus under contract.
 * Returns a diagnosis instead of throwing, so the caller can record exactly
 * why a frontmatter block was rejected.
 */
function parseYamlSubset(lines, firstLineNo) {
  const map = new Map();
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const lineNo = firstLineNo + i;
    if (/^\s*$/.test(raw) || /^\s*#/.test(raw)) {
      i += 1;
      continue;
    }
    if (/^\s*-(?:[ \t]|$)/.test(raw)) {
      return { ok: false, code: "FM_NOT_MAPPING", line: lineNo, detail: "frontmatter 根节点是序列，不是映射" };
    }
    const m = /^([A-Za-z_][A-Za-z0-9_.-]*):(.*)$/.exec(raw);
    if (!m) {
      return { ok: false, code: "FM_INVALID_YAML", line: lineNo, detail: `无法解析的 frontmatter 行: ${JSON.stringify(raw)}` };
    }
    const key = m[1];
    const rest = m[2];
    if (map.has(key)) {
      return {
        ok: false,
        code: "FM_DUPLICATE_KEY",
        line: lineNo,
        detail: `重复键 '${key}'（yaml v2 默认 uniqueKeys:true 会抛错）`,
      };
    }

    if (rest.trim() === "") {
      // Possibly an indented block sequence of scalars.
      const block = [];
      let j = i + 1;
      while (j < lines.length && (/^\s*$/.test(lines[j]) || /^\s/.test(lines[j]))) {
        block.push({ raw: lines[j], line: firstLineNo + j });
        j += 1;
      }
      const significant = block.filter((l) => l.raw.trim() !== "" && !/^\s*#/.test(l.raw));
      if (significant.length === 0) {
        map.set(key, null);
        i = j;
        continue;
      }
      const isSeq = significant.every((l) => /^\s*-(?:[ \t]|$)/.test(l.raw));
      if (!isSeq) {
        return {
          ok: false,
          code: "FM_INVALID_YAML",
          line: significant[0].line,
          detail: `不支持的嵌套结构（本子集只支持标量列表）: ${JSON.stringify(significant[0].raw)}`,
        };
      }
      const items = [];
      for (const l of significant) {
        const s = parseScalar(l.raw.replace(/^\s*-[ \t]?/, ""), l.line);
        if (!s.ok) {
          return { ok: false, code: "FM_INVALID_YAML", line: s.line, detail: s.detail };
        }
        items.push(s.value);
      }
      map.set(key, items);
      i = j;
      continue;
    }

    if (rest.trim().startsWith("[")) {
      const s = parseFlowSeq(rest.trim(), lineNo);
      if (!s.ok) return { ok: false, code: "FM_INVALID_YAML", line: s.line, detail: s.detail };
      map.set(key, s.value);
      i += 1;
      continue;
    }

    const s = parseScalar(rest, lineNo);
    if (!s.ok) return { ok: false, code: "FM_INVALID_YAML", line: s.line, detail: s.detail };
    map.set(key, s.value);
    i += 1;
  }
  return { ok: true, value: map };
}

/**
 * Tolerant frontmatter reader plus explicit diagnostics.
 * Mirrors ingest-v2/frontmatter.ts: parseFrontmatter() (missing/broken block →
 * `{type:"other"}`, hasFrontmatter:false) and readSources() (non-string entries
 * are filtered). Difference: every fallback is surfaced as a diagnostic.
 */
function parseFrontmatterContract(file, text) {
  const diagnostics = [];
  const push = (code, line, detail, fallback) =>
    diagnostics.push({ code, severity: code.startsWith("HEADING") ? "info" : "error", file, line, detail, fallback });

  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/.exec(text);
  const openOnly = /^---\r?\n/.test(text);
  let status;
  let fields = new Map();
  let body;

  if (fmMatch) {
    status = "ok";
    const block = fmMatch[1];
    const parsed = parseYamlSubset(block.split(/\r?\n/), 2);
    if (!parsed.ok) {
      status = parsed.code === "FM_NOT_MAPPING" ? "not-mapping" : parsed.code === "FM_DUPLICATE_KEY" ? "duplicate-key" : "invalid-yaml";
      fields = new Map();
      push(parsed.code, parsed.line, parsed.detail, "丢弃整块 frontmatter，type=other，hasFrontmatter=false");
    } else {
      fields = parsed.value;
    }
    // Keep the raw body even for a rejected block (matches parseFrontmatter()).
    body = text.slice(fmMatch[0].length);
  } else if (openOnly) {
    status = "unterminated";
    body = text;
    push(
      "FM_UNTERMINATED",
      1,
      "起始 `---` 后没有闭合的 `---` 行",
      "丢弃整块 frontmatter，type=other，hasFrontmatter=false，正文=全文",
    );
  } else {
    status = "absent";
    body = text;
    push("FM_ABSENT", null, "文件不以 `---` frontmatter 块开头", "type=other，title 取 basename");
  }

  // type: mirrors frontmatter.ts L60 (`typeof fm.type === "string" && fm.type.trim() ? … : "other"`).
  let type = "other";
  const rawType = fields.get("type");
  if (status === "ok") {
    if (typeof rawType === "string" && rawType.trim() !== "") {
      type = rawType.trim();
    } else {
      push("FM_TYPE_INVALID", null, `type=${JSON.stringify(rawType ?? null)} 不是非空字符串`, 'type="other"');
    }
  }

  // title: mirrors index-builder.ts L69-72 (fallback to file basename).
  const stem = basename(file).replace(/\.md$/, "");
  let title = stem;
  const rawTitle = fields.get("title");
  if (status === "ok" && typeof rawTitle === "string" && rawTitle.trim() !== "") {
    title = rawTitle.trim();
  } else {
    push(
      "FM_TITLE_FALLBACK",
      null,
      `title=${JSON.stringify(rawTitle ?? null)} 不可用`,
      `title="${stem}"（文件 basename）`,
    );
  }

  // sources: mirrors readSources() filtering + adds a count of dropped entries.
  let sources = [];
  const rawSources = fields.get("sources");
  if (status === "ok" && rawSources !== undefined && rawSources !== null) {
    if (Array.isArray(rawSources)) {
      sources = rawSources.filter((x) => typeof x === "string");
      const dropped = rawSources.length - sources.length;
      if (dropped > 0) {
        push(
          "FM_SOURCES_NON_STRING",
          null,
          `sources 含 ${dropped} 个非字符串条目: ${JSON.stringify(rawSources.filter((x) => typeof x !== "string"))}`,
          `只保留字符串条目 → [${sources.map((s) => `"${s}"`).join(", ")}]`,
        );
      }
    } else {
      push("FM_SOURCES_NOT_ARRAY", null, `sources=${JSON.stringify(rawSources)} 不是数组`, "sources=[]");
    }
  }

  return { status, type, title, sources, body, diagnostics };
}

// ---------------------------------------------------------------------------
// heading extraction (fence-aware; chunker.ts L32 is the naive reference)
// ---------------------------------------------------------------------------

function extractHeadings(body) {
  const lines = body.split(/\r?\n/);
  const headings = [];
  let fence = null;
  let skippedInFence = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fenceMatch = /^[ \t]*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence !== null) {
      if (/^#{1,6}[ \t]+\S/.test(line)) skippedInFence += 1;
      continue;
    }
    const m = /^(#{1,6})[ \t]+(\S.*?)[ \t]*$/.exec(line);
    if (m) headings.push({ line: i + 1, level: m[1].length, text: m[2] });
  }
  return { headings, skippedInFence };
}

// ---------------------------------------------------------------------------
// normalization pipeline
// ---------------------------------------------------------------------------

function normalizeFiles(corpus) {
  return corpus.map((entry) => {
    const fm = parseFrontmatterContract(entry.file, entry.text);
    const { headings, skippedInFence } = extractHeadings(fm.body);
    const requestedPath = pageRelPath(fm.type, fm.title);
    const slug = slugify(fm.title);
    const diagnostics = [...fm.diagnostics];
    if (!slug) {
      diagnostics.push({
        code: "PAGE_SLUG_EMPTY",
        severity: "error",
        file: entry.file,
        line: null,
        detail: `title ${JSON.stringify(fm.title)} 归一化为空 slug`,
        fallback: "保留 pageRelPath 的原始输出，交由冲突检测处理",
      });
    }
    return {
      file: entry.file,
      name: entry.name,
      digest: entry.digest,
      frontmatter: {
        status: fm.status,
        hasFrontmatter: fm.status === "ok",
        type: fm.type,
        typeDir: dirForType(fm.type),
        title: fm.title,
        slug,
        sources: fm.sources,
      },
      requestedPath,
      headings: headings.map((h) => ({ ...h, slug: slugify(h.text) })),
      skippedHeadingsInFence: skippedInFence,
      diagnostics,
    };
  });
}

function buildPages(files) {
  const groups = new Map();
  for (const f of files) {
    const arr = groups.get(f.requestedPath) ?? [];
    arr.push(f);
    groups.set(f.requestedPath, arr);
  }

  const pages = [];
  for (const requestedPath of [...groups.keys()].sort(cmp)) {
    const members = groups.get(requestedPath);
    members.forEach((f, idx) => {
      let path = requestedPath;
      if (idx > 0) {
        path = requestedPath.replace(/\.md$/, `-${idx + 1}.md`);
        const diag = {
          code: "PAGE_PATH_COLLISION",
          severity: "error",
          file: f.file,
          line: 1,
          detail: `与 ${members[0].file} 归一到同一页 ${requestedPath}（type=${f.frontmatter.type}, title=${JSON.stringify(
            f.frontmatter.title,
          )}）`,
          fallback: `保留首文件的路径，本文件落点改为 ${path}`,
        };
        f.diagnostics.push(diag);
      }
      f.assignedPath = path;
      f.collisionIndex = idx;
    });

    const anchorOwners = new Map();
    const headings = [];
    for (const f of members) {
      for (const h of f.headings) {
        if (!h.slug) {
          const diag = {
            code: "HEADING_SLUG_EMPTY",
            severity: "info",
            file: f.file,
            line: h.line,
            detail: `标题 ${JSON.stringify(h.text)} 归一化为空 slug`,
            fallback: "跳过该标题（不进入 index/锚点表）",
          };
          f.diagnostics.push(diag);
          continue;
        }
        const seen = anchorOwners.get(h.slug);
        const anchor = seen ? `${h.slug}-${seen.count + 1}` : h.slug;
        if (seen) {
          seen.count += 1;
          f.diagnostics.push({
            code: "HEADING_DUPLICATE",
            severity: "info",
            file: f.file,
            line: h.line,
            detail: `锚点 '${h.slug}' 已被 ${seen.firstFile}:${seen.firstLine} 占用（原文 ${JSON.stringify(seen.firstText)}）`,
            fallback: `anchor="${anchor}"（确定性 -N 后缀）`,
          });
        } else {
          anchorOwners.set(h.slug, { count: 1, firstFile: f.file, firstLine: h.line, firstText: h.text });
        }
        headings.push({
          file: f.file,
          line: h.line,
          level: h.level,
          text: h.text,
          slug: h.slug,
          anchor,
          duplicateOf: seen ? h.slug : null,
        });
      }
    }

    pages.push({
      path: members[0].assignedPath,
      requestedPath,
      type: members[0].frontmatter.type,
      typeDir: members[0].frontmatter.typeDir,
      titles: members.map((m) => m.frontmatter.title),
      sourceFiles: members.map((m) => m.file),
      mergedFrom: members.length,
      anchors: headings.map((h) => h.anchor),
      headings,
    });
  }
  return { pages };
}

function renderWikiIndex(pages) {
  // Group order mirrors index-builder.ts GROUP_ORDER (L22-28) + unknown-type fallback (L112-113).
  const PREFERRED = ["sources", "entities", "concepts", "comparisons", "synthesis"];
  const groups = new Map();
  for (const p of pages) {
    const dir = p.path.split("/")[1];
    const arr = groups.get(dir) ?? [];
    arr.push(p);
    groups.set(dir, arr);
  }
  const dirs = [...groups.keys()].sort((a, b) => {
    const ia = PREFERRED.indexOf(a);
    const ib = PREFERRED.indexOf(b);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? Number.MAX_SAFE_INTEGER : ia) - (ib === -1 ? Number.MAX_SAFE_INTEGER : ib);
    return cmp(a, b);
  });

  const out = ["# Index (normalized corpus)", ""];
  for (const dir of dirs) {
    out.push(`## ${dir.charAt(0).toUpperCase()}${dir.slice(1)}`, "");
    for (const p of groups.get(dir).sort((a, b) => cmp(a.path, b.path))) {
      const desc = `${p.mergedFrom > 1 ? `merged from ${p.mergedFrom} files; ` : ""}anchors: ${p.anchors.length}`;
      out.push(`* [${p.titles[0]}](/${p.path}) - ${desc}`);
    }
    out.push("");
  }
  return `${out.join("\n").replace(/\n+$/, "")}\n`;
}

function buildState(backend) {
  const corpus = readCorpus();
  const files = normalizeFiles(corpus);
  const { pages } = buildPages(files);

  const diagnostics = files
    .flatMap((f) => f.diagnostics)
    .sort((a, b) => cmp(a.file, b.file) || (a.line ?? -1) - (b.line ?? -1) || cmp(a.code, b.code));

  const diagnosticSummary = {};
  for (const code of Object.keys(CODES).sort(cmp)) {
    const n = diagnostics.filter((d) => d.code === code).length;
    if (n > 0) diagnosticSummary[code] = n;
  }

  return {
    task: { task_id: "T03", repository: "tdam", mode: "contract" },
    purpose:
      "Normalize a non-wiki documentation corpus (duplicate headings + malformed frontmatter) with the repository's real slug rules; surface every invalid-metadata fallback explicitly.",
    sourceSymbols: [
      { path: "MemoryKnowledge/src/engines/wiki/ingest-v2/slug.ts", symbol: "slugify", lines: "30-64", role: "entity name/title → stable slug (the only slug implementation used here)" },
      { path: "MemoryKnowledge/src/engines/wiki/ingest-v2/slug.ts", symbol: "dirForType", lines: "84-87", role: "page type → wiki directory (entity→entities, unknown type → itself)" },
      { path: "MemoryKnowledge/src/engines/wiki/ingest-v2/slug.ts", symbol: "pageRelPath", lines: "94-98", role: "canonical wiki/<dir>/<slug>.md path used for dedup" },
    ],
    backends: backend,
    diagnosticVocabulary: CODES,
    corpus: {
      root: ".prale-eval/corpus",
      files: corpus.map((c) => ({ file: c.file, sha256: c.digest })),
      digest: sha256(corpus.map((c) => `${c.file}:${c.digest}`).join("\n")),
    },
    files: files.map((f) => ({
      file: f.file,
      sha256: f.digest,
      frontmatter: f.frontmatter,
      requestedPath: f.requestedPath,
      assignedPath: f.assignedPath,
      collisionIndex: f.collisionIndex,
      headingCount: f.headings.length,
      skippedHeadingsInFence: f.skippedHeadingsInFence,
      diagnostics: f.diagnostics,
    })),
    pages: pages.map((p) => ({
      path: p.path,
      requestedPath: p.requestedPath,
      type: p.type,
      typeDir: p.typeDir,
      titles: p.titles,
      sourceFiles: p.sourceFiles,
      mergedFrom: p.mergedFrom,
      anchors: p.anchors,
      headings: p.headings,
    })),
    diagnostics,
    diagnosticSummary,
  };
}

// ---------------------------------------------------------------------------
// optional cross-check against the real frontmatter.ts (needs the `yaml` dep)
// ---------------------------------------------------------------------------

async function resolveBackends() {
  let frontmatter;
  try {
    const mod = await import("../MemoryKnowledge/src/engines/wiki/ingest-v2/frontmatter.ts");
    frontmatter = { module: "MemoryKnowledge/src/engines/wiki/ingest-v2/frontmatter.ts", available: true, error: null };
    void mod;
  } catch (err) {
    frontmatter = {
      module: "MemoryKnowledge/src/engines/wiki/ingest-v2/frontmatter.ts",
      available: false,
      error: String(err?.code ?? "ERR") + ": " + String(err?.message ?? err).split("\n")[0],
      limitation:
        "`yaml` is not installed in this workspace and dependencies must not be installed, so parseFrontmatter() could not be executed. The demo mirrors its contract (bad block → {type:\"other\"}, hasFrontmatter:false; sources filtered to strings) and additionally records an explicit diagnostic per fallback.",
    };
  }
  return {
    slug: {
      module: "MemoryKnowledge/src/engines/wiki/ingest-v2/slug.ts",
      available: true,
      imported: ["slugify", "dirForType", "pageRelPath"],
      error: null,
    },
    frontmatter,
  };
}

// ---------------------------------------------------------------------------
// checks
// ---------------------------------------------------------------------------

function runChecks(state, serialized, previousCanonical) {
  const results = [];
  const add = (name, pass, detail) => results.push({ name, status: pass ? "pass" : "fail", detail });

  // 1. slugify idempotence (same input → same output; slug of a slug is stable)
  const probes = new Set(["Redis 主从", "  --Redis   Cluster--  ", "中文！！标题", "1. 客户端接入配置", ""]);
  for (const f of state.files) {
    probes.add(f.frontmatter.title);
  }
  for (const p of state.pages) for (const h of p.headings) probes.add(h.text);
  const bad = [...probes].filter((p) => slugify(slugify(p)) !== slugify(p));
  add("slugify is idempotent", bad.length === 0, bad.length ? `unstable: ${JSON.stringify(bad)}` : `${probes.size} probes: slugify(slugify(x)) === slugify(x)`);

  // 2. fresh in-process runs are byte-identical
  const digests = [1, 2, 3].map((n) => sha256(serialize(buildState(state.backends))));
  add("three fresh runs produce identical bytes", new Set(digests).size === 1, digests.join(" "));

  // 3. cross-process determinism (canonical digest left by the previous process)
  if (previousCanonical === null) {
    add("cross-process determinism", true, "no previous canonical digest on disk (baseline created by this run)");
  } else {
    add(
      "cross-process determinism",
      previousCanonical === sha256(serialized),
      previousCanonical === sha256(serialized) ? "canonical digest identical to previous process run" : "previous run differs",
    );
  }

  // 4. invalid metadata is handled explicitly
  const malformed = state.files.filter((f) => f.frontmatter.status !== "ok");
  const silent = malformed.filter(
    (f) => !f.diagnostics.some((d) => d.severity === "error" && typeof d.fallback === "string" && d.fallback.length > 0),
  );
  const wrongType = malformed.filter((f) => f.frontmatter.type !== "other");
  add(
    "malformed frontmatter is explicit",
    malformed.length >= 4 && silent.length === 0 && wrongType.length === 0,
    `${malformed.length} files with rejected frontmatter, ${silent.length} silent, ${wrongType.length} without type=other → ${malformed
      .map((f) => `${basename(f.file)}=${f.frontmatter.status}`)
      .join(", ")}`,
  );

  // 5. every fallback is described
  const noFallback = state.diagnostics.filter((d) => !d.fallback || !d.detail);
  add("every diagnostic carries detail + fallback", noFallback.length === 0, `${state.diagnostics.length} diagnostics`);

  // 6. anchors unique per normalized page
  const dupAnchors = state.pages.filter((p) => new Set(p.anchors).size !== p.anchors.length);
  add("anchors unique per page", dupAnchors.length === 0, `${state.pages.length} pages, ${dupAnchors.length} with duplicate anchors`);

  // 7. duplicate headings were actually present and deterministically suffixed
  const dupes = state.diagnostics.filter((d) => d.code === "HEADING_DUPLICATE");
  const suffixed = state.pages.flatMap((p) => p.headings.filter((h) => h.duplicateOf)).length;
  add("duplicate headings deduped deterministically", dupes.length >= 4 && suffixed === dupes.length, `${dupes.length} duplicate headings → ${dupes.map((d) => d.fallback).join(" | ")}`);

  // 8. page collisions were detected and merged deterministically
  const collisions = state.diagnostics.filter((d) => d.code === "PAGE_PATH_COLLISION");
  const mergedPages = state.pages.filter((p) => p.mergedFrom > 1);
  const suffixWrong = mergedPages.filter((p) => {
    // First file (code-point order) keeps the requested path; every later file
    // must have been moved to a `-N` path in that same order.
    const ordered = p.sourceFiles.slice().sort(cmp);
    return p.sourceFiles.some((file) => {
      const entry = state.files.find((x) => x.file === file);
      const rank = ordered.indexOf(file);
      const expected = rank === 0 ? p.requestedPath : p.requestedPath.replace(/\.md$/, `-${rank + 1}.md`);
      return entry.assignedPath !== expected;
    });
  });
  add(
    "page collisions detected and merged deterministically",
    collisions.length >= 1 && mergedPages.length >= 1 && suffixWrong.length === 0,
    `${collisions.length} collision(s), merged page(s): ${mergedPages
      .map((p) => `${p.requestedPath} ← ${p.sourceFiles.join(" + ")}`)
      .join(", ")}`,
  );

  // 9. no timestamps / volatile fields in the artifact
  add("report is time-free and locale-free", !/\d{4}-\d{2}-\d{2}T/.test(serialized) && !serialized.includes("localeCompare"), "no ISO timestamps, no localeCompare");

  return results;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const backends = await resolveBackends();
  const state = buildState(backends);
  const serialized = serialize(state);
  const digest = sha256(serialized);
  const indexText = renderWikiIndex(state.pages);

  // The canonical state is a pure function of the corpus bytes, so the report
  // written below must be byte-identical across processes. Only run-dependent
  // evidence (previous-run comparison + check results) goes to validation.json.
  const previousText = existsSync(REPORT_PATH) ? readFileSync(REPORT_PATH, "utf-8") : null;
  const previousDigest = previousText ? sha256(previousText) : null;
  const previousCanonical = previousText ? JSON.parse(previousText).determinism?.canonicalDigest ?? null : null;

  const checks = runChecks(state, serialized, previousCanonical);
  const failed = checks.filter((c) => c.status === "fail");

  const report = {
    ...state,
    determinism: {
      canonicalDigest: digest,
      canonicalDigestScope:
        "sha256 of the canonical state, i.e. this report without the `determinism` block (the block itself would reference its own digest)",
      inProcessRuns: 3,
      inProcessIdentical: new Set([1, 2, 3].map(() => sha256(serialize(buildState(backends))))).size === 1,
      idempotentSymbols: ["slugify"],
      volatileFields: [],
    },
  };
  const reportText = serialize(report);

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(REPORT_PATH, reportText, "utf-8");
  writeFileSync(INDEX_PATH, indexText, "utf-8");

  // Cross-process proof: the file just written must equal the file this run read.
  const writtenBack = readFileSync(REPORT_PATH, "utf-8");
  const crossProcessIdentical = previousText === null ? null : previousText === writtenBack;
  const validation = {
    task: state.task,
    command: "node .prale-eval/normalize.mjs --check",
    status: failed.length === 0 ? "pass" : "fail",
    checks,
    artifacts: {
      report: { path: ".prale-eval/out/normalization-report.json", sha256: sha256(reportText) },
      wikiIndex: { path: ".prale-eval/out/wiki-index.md", sha256: sha256(indexText) },
    },
    crossProcess: {
      previousReportDigest: previousDigest,
      previousCanonicalDigest: previousCanonical,
      currentCanonicalDigest: digest,
      identical: crossProcessIdentical,
      note:
        crossProcessIdentical === null
          ? "baseline run: no previous report existed; determinism asserted in-process (3 fresh runs) — re-run --check to prove cross-process byte equality"
          : "previous report bytes are identical to the bytes written by this run",
    },
  };
  writeFileSync(join(OUT_DIR, "validation.json"), serialize(validation), "utf-8");

  console.log("== T03 tdam contract: corpus normalization ==");
  console.log(`corpus files : ${state.files.length} (${state.corpus.digest.slice(0, 12)})`);
  console.log(`pages        : ${state.pages.length}`);
  console.log(`diagnostics  : ${state.diagnostics.length} → ${JSON.stringify(state.diagnosticSummary)}`);
  console.log(`report digest: ${digest}`);
  console.log(`wiki index   : ${sha256(indexText).slice(0, 12)}`);
  for (const c of checks) console.log(`[${c.status === "pass" ? "PASS" : "FAIL"}] ${c.name} — ${c.detail}`);
  console.log(
    `cross-process: ${
      crossProcessIdentical === null ? "baseline (no previous report)" : crossProcessIdentical ? "byte-identical" : "DIFFERS"
    }`,
  );
  console.log(failed.length === 0 ? "RESULT: PASS" : `RESULT: FAIL (${failed.length})`);

  if (failed.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("normalize.mjs crashed:", err);
  process.exitCode = 2;
});
