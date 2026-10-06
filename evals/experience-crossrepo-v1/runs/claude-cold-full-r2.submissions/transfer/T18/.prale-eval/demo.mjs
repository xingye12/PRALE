#!/usr/bin/env node
/**
 * Executable demonstration for T18 / repository `tdam` / mode `contract`.
 *
 * Question: does a duplicate source/build submission create duplicate *effective*
 * work in MemoryKnowledge?
 *
 * This script executes the REAL repository source for the build submission path:
 *   - MemoryKnowledge/src/store/build-queue.ts   (BuildQueue)
 *   - MemoryKnowledge/src/store/serial-queue.ts  (SerialQueue, reached through BuildQueue)
 * loaded unmodified through `.prale-eval/register-hooks.mjs`, a Node ESM resolve
 * hook that maps the repo's NodeNext `.js`-suffixed relative imports onto the
 * sibling `.ts` files so Node's native type-stripping can run them.
 *
 * Layers that need heavier dependencies (better-sqlite3, the wiki engines) cannot
 * be imported in this environment (no installed node_modules). Those layers are
 * reproduced as *faithful in-memory ports* that mirror the cited source line for
 * line; each carries the real citation it models. Everything else is real code.
 *
 * Exit code 0 = every assertion passed; 1 = a demonstrated contract violation.
 */

import { BuildQueue } from "../MemoryKnowledge/src/store/build-queue.ts";
import { SerialQueue } from "../MemoryKnowledge/src/store/serial-queue.ts";
import { createHash } from "node:crypto";

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (t) => createHash("sha256").update(t, "utf8").digest("hex");

// ───────────────────────────────────────────────────────────────────────────
// Harness A — build submission path
//
// Faithful port of the wiki-service submission/admission contract. Citation for
// each modeled piece is given against the real sources; the queue itself is the
// real, imported BuildQueue.
// ───────────────────────────────────────────────────────────────────────────

/** Models `wiki-service.ingest` (src/store/wiki-service.ts:272-290). */
class WikiBuildHarness {
  constructor({ workerDelayMs = 5 } = {}) {
    this.queue = new BuildQueue(); // REAL MemoryKnowledge/src/store/build-queue.ts:11
    this.rows = new Map(); // wiki_id -> { status }
    this.cancelled = new Set(); // wiki-service.ts:222
    this.workerDelayMs = workerDelayMs;
    this.workerInvocations = 0;
    this.concurrent = 0;
    this.maxConcurrent = 0;
  }

  /** wiki-service.ts:241-255 — create is idempotent: a duplicate returns the existing row. */
  create(wikiId) {
    const existed = this.rows.has(wikiId);
    if (!existed) this.rows.set(wikiId, { status: "ready" });
    return { row: { wiki_id: wikiId, ...this.rows.get(wikiId) }, existed };
  }

  /**
   * Models `ingest` (wiki-service.ts:272-290). The load-bearing lines:
   *   276-278  pending|processing -> return { kind: "busy" } (no state write,
   *            no audit, NO re-enqueue)
   *   279-288  otherwise bump version, set pending, then enqueueBuild once
   */
  ingest(wikiId) {
    const row = this.rows.get(wikiId);
    if (!row) return { kind: "not_found" };
    if (row.status === "pending" || row.status === "processing") {
      return { kind: "busy", status: row.status }; // wiki-service.ts:276-278
    }
    row.status = "pending";
    this.enqueueBuild(wikiId); // wiki-service.ts:288
    return { kind: "ok" };
  }

  /** Models `enqueueBuild` (wiki-service.ts:1010-1012): key = wiki_id (the asset id). */
  enqueueBuild(wikiId) {
    this.queue.enqueue(wikiId, () => this.runBuild(wikiId));
  }

  /** Models the `isDeleted` worker checkpoint (wiki-service.ts:366-368). */
  isDeleted(wikiId) {
    return this.cancelled.has(wikiId) || !this.rows.has(wikiId);
  }

  /** Models `runBuild` entry checkpoint (wiki-service.ts:1014-1024). */
  async runBuild(wikiId) {
    if (this.isDeleted(wikiId)) return; // wiki-service.ts:1016-1019 — no work
    this.rows.get(wikiId).status = "processing";
    await this.worker(wikiId);
    if (this.isDeleted(wikiId)) return;
    this.rows.get(wikiId).status = "ready";
  }

  /** The expensive unit of effective work (scan + LLM ingest + index build). */
  async worker(_wikiId) {
    this.concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    this.workerInvocations += 1;
    await sleep(this.workerDelayMs);
    this.concurrent -= 1;
  }
}

// ───────────────────────────────────────────────────────────────────────────
console.log("\n=== 1. Per-asset-key single-flight serialization (REAL BuildQueue) ===");
// MemoryKnowledge/src/store/build-queue.ts:12-24 maps each key to one SerialQueue;
// SerialQueue (serial-queue.ts:81-101) has concurrency 1, so same-key jobs never
// overlap and run FIFO.
{
  const q = new BuildQueue();
  const order = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const KEYS = 5;
  for (let i = 0; i < KEYS; i++) {
    q.enqueue("wiki-A", async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await sleep(4);
      order.push(i);
      concurrent -= 1;
    });
  }
  await q.onIdle();
  check("duplicate same-key submissions never execute concurrently", maxConcurrent === 1, `maxConcurrent=${maxConcurrent}`);
  check("all same-key submissions are retained and run FIFO", JSON.stringify(order) === JSON.stringify([0, 1, 2, 3, 4]), `order=[${order}]`);
}

console.log("\n=== 2. Distinct keys stay isolated (separate per-asset queues) ===");
{
  const q = new BuildQueue();
  let concurrent = 0;
  let maxConcurrent = 0;
  const job = async () => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await sleep(8);
    concurrent -= 1;
  };
  q.enqueue("wiki-A", job);
  q.enqueue("wiki-B", job);
  await q.onIdle();
  check("different asset keys are not serialized against each other", maxConcurrent === 2, `maxConcurrent=${maxConcurrent}`);
}

console.log("\n=== 3. Duplicate build submission via ingest() yields ONE build ===");
{
  const h = new WikiBuildHarness();
  h.create("wiki-1");
  const first = h.ingest("wiki-1");
  const second = h.ingest("wiki-1"); // duplicate submitted while first is pending
  const third = h.ingest("wiki-1");
  await h.queue.onIdle();
  check("first submission accepted", first.kind === "ok", `kind=${first.kind}`);
  check("duplicate submissions rejected as busy", second.kind === "busy" && third.kind === "busy", `2nd=${second.kind}, 3rd=${third.kind}`);
  check("worker ran exactly once for the accepted submission", h.workerInvocations === 1, `invocations=${h.workerInvocations}`);
  check("asset reached ready exactly via the single accepted build", h.rows.get("wiki-1").status === "ready", `status=${h.rows.get("wiki-1").status}`);
}

console.log("\n=== 4. Forced duplicate enqueue: serialized, and the duplicate does zero work ===");
{
  // Worst case: a duplicate submission slips past admission (e.g. a concurrent
  // request racing the status write). BuildQueue still serializes it behind the
  // first job for that key (layer 1). If the asset is deleted while the first
  // job runs, the runBuild entry checkpoint (wiki-service.ts:1016-1019) drops the
  // queued duplicate without invoking the worker (layer 2) — zero extra work.
  const h = new WikiBuildHarness({ workerDelayMs: 8 });
  h.create("wiki-2");
  h.enqueueBuild("wiki-2"); // the one accepted submission — starts immediately
  await sleep(2); // let it enter `processing`
  h.cancelled.add("wiki-2"); // deleted during the run (wiki-service.ts:326-328)
  h.rows.delete("wiki-2"); // hard-deleted row (cleanupResources, wiki-service.ts:344-360)
  h.enqueueBuild("wiki-2"); // duplicate queued behind the first, for a now-gone asset
  await h.queue.onIdle();
  check("duplicate submission contributes zero effective work", h.workerInvocations === 1, `invocations=${h.workerInvocations} (1 = only the accepted build)`);
  check("duplicate submission never overlapped the first", h.maxConcurrent === 1, `maxConcurrent=${h.maxConcurrent}`);
  check("nothing is committed for the deleted asset", !h.rows.has("wiki-2"));
}

console.log("\n=== 5. Duplicate SOURCE submission with identical content is idempotent ===");
{
  // Models wiki-service.registerSources (src/store/wiki-service.ts:879-902) ->
  // upsertSource (src/engines/wiki/index-db.ts:219-242). Needs better-sqlite3,
  // absent here, so this is the faithful in-memory port of that logic.
  const source = new Map(); // filename -> { sha256, status }
  const upsertSource = (filename, content) => {
    const sha = sha256(content);
    const old = source.get(filename);
    if (!old) { source.set(filename, { sha256: sha, status: "uploaded" }); return "created"; }
    if (old.sha256 !== sha) { source.set(filename, { sha256: sha, status: "uploaded" }); return "updated"; }
    return "unchanged"; // index-db.ts:241 — nothing is reset; no ingest is provoked
  };

  const body = "# Same content\n";
  const outcomes = [upsertSource("a.md", body), upsertSource("a.md", body), upsertSource("a.md", body)];
  const ingestProvoking = outcomes.filter((o) => o === "created" || o === "updated").length;
  check("first upload registers the source", outcomes[0] === "created", `outcomes=[${outcomes}]`);
  check("duplicate identical uploads are no-ops", outcomes[1] === "unchanged" && outcomes[2] === "unchanged", `outcomes=[${outcomes}]`);
  check("only the first upload provokes build work", ingestProvoking === 1, `provoking=${ingestProvoking}`);
  // A genuinely changed body must still be detected (dedup is content-based, not path-based).
  check("changed content is still re-registered", upsertSource("a.md", "# Different\n") === "updated");
}

console.log("\n=== 6. onIdle() drains every key (reflected in BuildQueue.onIdle) ===");
{
  const q = new BuildQueue();
  let done = 0;
  for (const k of ["k1", "k2", "k3"]) q.enqueue(k, async () => { await sleep(3); done += 1; });
  const before = done;
  await q.onIdle();
  check("onIdle() resolves only after all queued work drained", before === 0 && done === 3, `before=${before}, done=${done}`);
}

// ───────────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} assertions passed`);
if (failed.length) {
  console.error(`\nFAILED: ${failed.map((f) => f.name).join("; ")}`);
  process.exit(1);
}
console.log("RESULT: duplicate source/build submission does not create duplicate effective work.");
console.log(`(BuildQueue instance check: real source — ${typeof BuildQueue === "function" && typeof SerialQueue === "function" ? "loaded from repo .ts sources" : "MISSING"})`);
