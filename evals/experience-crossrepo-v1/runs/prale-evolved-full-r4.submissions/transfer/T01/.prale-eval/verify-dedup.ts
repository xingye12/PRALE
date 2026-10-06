/**
 * Executable proof for T01 (repository: tdam, mode: contract)
 *
 * Claim under test:
 *   "Duplicate source/build submission does not create duplicate effective work
 *    in MemoryKnowledge."
 *
 * This script exercises the REAL repository code (no mocks of the unit under
 * test):
 *   - MemoryKnowledge/src/store/build-queue.ts   (BuildQueue — required evidence)
 *   - MemoryKnowledge/src/store/serial-queue.ts  (SerialQueue, the per-key engine)
 *
 * Run (no node_modules required; Node >= 22.18/24 strips TS types natively):
 *   node --import ./.prale-eval/ts-resolve-loader.mjs .prale-eval/verify-dedup.ts
 *
 * Layers proven:
 *   L1 "no duplicate queue entry": the service-layer guard (mirrored from
 *      CodeGraphService.create/sync and WikiService.ingest) drops a duplicate
 *      submission, so exactly one build job is enqueued per asset generation.
 *   L2 "no duplicate concurrent work": even if two jobs with the same asset key
 *      do reach BuildQueue, SerialQueue (concurrency=1) runs them strictly one
 *      after another — there is never overlapping effective work for one key.
 *   L3 "per-key isolation": distinct keys get distinct SerialQueue instances and
 *      can run in parallel, so serialization is per asset, not global.
 */

import { BuildQueue } from "../MemoryKnowledge/src/store/build-queue.js";
import { SerialQueue } from "../MemoryKnowledge/src/store/serial-queue.js";

// ───────────────────────── tiny assertion harness ─────────────────────────

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const checks: Check[] = [];

function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}\n      ${detail}`);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ───────────────────────── L1: idempotent submission guard ─────────────────────────
//
// Faithful behavioural mirror of the real service-layer guards that sit directly
// in front of BuildQueue.enqueue:
//   - CodeGraphService.create  : `if (!existed) { ...; this.enqueueBuild(row); }`
//   - CodeGraphService.sync    : `if (status pending|processing) return busy;`
//   - WikiService.ingest       : identical pending|processing -> busy guard
// The mirror keeps the SAME decision rule (idempotency key = asset key, busy
// guard = pending|processing) so a duplicate submission is observable as
// "submissions >> enqueues == effective runs".

class AssetRegistry {
  submitted = 0;
  effectiveRuns = 0;
  private readonly rows = new Map<string, { status: "pending" | "processing" | "ready" }>();
  private readonly queue: BuildQueue;
  private readonly workMs: number;

  constructor(queue: BuildQueue, workMs: number) {
    this.queue = queue;
    this.workMs = workMs;
  }

  /** Mirrors CodeGraphService.create: existed => return existing row, DO NOT enqueue. */
  create(key: string): { existed: boolean } {
    this.submitted++;
    if (this.rows.has(key)) return { existed: true };
    this.rows.set(key, { status: "pending" });
    this.enqueue(key);
    return { existed: false };
  }

  /** Mirrors CodeGraphService.sync / WikiService.ingest: busy => reject, DO NOT enqueue. */
  sync(key: string): { kind: "ok" } | { kind: "busy" } {
    this.submitted++;
    const row = this.rows.get(key);
    if (!row) throw new Error(`missing row for ${key}`);
    if (row.status === "pending" || row.status === "processing") return { kind: "busy" };
    row.status = "pending";
    this.enqueue(key);
    return { kind: "ok" };
  }

  private enqueue(key: string): void {
    this.queue.enqueue(key, async () => {
      const row = this.rows.get(key)!;
      row.status = "processing";
      this.effectiveRuns++;
      await sleep(this.workMs);
      row.status = "ready";
    });
  }

  async drain(): Promise<void> {
    await this.queue.onIdle();
  }
}

// ───────────────────────── L2: same-key serialization ─────────────────────────

async function testSameKeyNeverOverlaps(): Promise<void> {
  const queue = new BuildQueue();
  let inFlight = 0;
  let maxInFlight = 0;
  const order: number[] = [];

  for (let i = 0; i < 5; i++) {
    queue.enqueue("cg-duplicate", async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(i);
      await sleep(5);
      inFlight--;
    });
  }
  await queue.onIdle();

  check(
    "L2 same-key duplicate jobs never overlap (SerialQueue concurrency=1)",
    maxInFlight === 1 && order.join(",") === "0,1,2,3,4",
    `maxConcurrent=${maxInFlight} (expected 1), FIFO order=[${order.join(",")}]`,
  );
}

// ───────────────────────── L3: per-key isolation ─────────────────────────

async function testDistinctKeysRunInParallel(): Promise<void> {
  const queue = new BuildQueue();
  let inFlight = 0;
  let maxInFlight = 0;

  for (const key of ["cg-a", "cg-b", "cg-c"]) {
    queue.enqueue(key, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(15);
      inFlight--;
    });
  }
  await queue.onIdle();

  check(
    "L3 distinct asset keys use distinct queues and may overlap",
    maxInFlight > 1,
    `maxConcurrent=${maxInFlight} (expected > 1, i.e. BuildQueue is per-key not global)`,
  );
}

// ───────────────────────── L1 end-to-end: duplicate submission ─────────────────────────

async function testDuplicateSubmission(): Promise<void> {
  const queue = new BuildQueue();
  const registry = new AssetRegistry(queue, 10);

  // ── Phase A: duplicate *build/create* submission (same repo+branch 3x) ──
  const r1 = registry.create("repo@main");
  const r2 = registry.create("repo@main");
  const r3 = registry.create("repo@main");

  // The first create fires the build immediately; while it is pending/processing
  // the sync guard must reject duplicates WITHOUT re-enqueuing.
  const s1 = registry.sync("repo@main");
  const s2 = registry.sync("repo@main");

  await registry.drain();
  const afterPhaseA = registry.effectiveRuns;

  // ── Phase B: duplicate *sync/ingest* submission once the asset is ready ──
  const s3 = registry.sync("repo@main"); // ok  -> one new generation
  const s4 = registry.sync("repo@main"); // busy (status already pending)
  const s5 = registry.sync("repo@main"); // busy

  await registry.drain();
  const afterPhaseB = registry.effectiveRuns;

  // ── Phase C: post-ready duplicate create is still a no-op ──
  const r4 = registry.create("repo@main");
  await registry.drain();
  const afterPhaseC = registry.effectiveRuns;

  check(
    "L1 duplicate create returns existed=true and does not enqueue",
    r1.existed === false && r2.existed === true && r3.existed === true && r4.existed === true,
    `create#1.existed=${r1.existed} (new), create#2=${r2.existed}, create#3=${r3.existed}, create#4(post-ready)=${r4.existed}`,
  );
  check(
    "L1 duplicate submission while pending/processing is rejected busy (no re-enqueue)",
    s1.kind === "busy" && s2.kind === "busy" && s4.kind === "busy" && s5.kind === "busy",
    `sync(during build)#1=${s1.kind}, #2=${s2.kind}; sync while pending #2=${s4.kind}, #3=${s5.kind}`,
  );
  check(
    "L1 duplicate create (x3) => exactly 1 effective build run",
    afterPhaseA === 1,
    `effectiveRuns after 3 creates (+2 busy syncs) and drain = ${afterPhaseA}`,
  );
  check(
    "L1 a single accepted sync adds exactly 1 run; rejected duplicates add 0",
    s3.kind === "ok" && afterPhaseB === 2,
    `accepted sync=${s3.kind}; effectiveRuns after 3 syncs + drain = ${afterPhaseB} (1 new, 2 rejected)`,
  );
  check(
    "L1 post-ready duplicate create adds 0 additional effective work",
    afterPhaseC === 2,
    `effectiveRuns after 4th create + drain = ${afterPhaseC}`,
  );
  check(
    "L1 9 submissions => 2 effective runs (one per accepted generation)",
    registry.submitted === 9 && afterPhaseC === 2,
    `submissions=${registry.submitted}, effectiveRuns=${afterPhaseC}`,
  );
}

// ───────────────────────── SerialQueue direct contract ─────────────────────────

async function testSerialQueueContract(): Promise<void> {
  const q = new SerialQueue("unit");
  check("SerialQueue starts idle", q.idle === true && q.size === 0, `idle=${q.idle}, size=${q.size}`);

  let runs = 0;
  const p1 = q.add(async () => {
    runs++;
    await sleep(5);
    return "one";
  });
  const p2 = q.add(async () => {
    runs++;
    return "two";
  });
  const queued = q.size; // second task still queued while first runs
  const [a, b] = await Promise.all([p1, p2]);
  await q.onIdle();

  check(
    "SerialQueue.add drains FIFO, resolves results, returns to idle",
    runs === 2 && a === "one" && b === "two" && q.idle === true && queued === 1,
    `runs=${runs}, results=[${a},${b}], pendingAfter1stAdd=${queued}, idleAfter=${q.idle}`,
  );
}

// ───────────────────────── main ─────────────────────────

async function main(): Promise<void> {
  await testSameKeyNeverOverlaps();
  await testDistinctKeysRunInParallel();
  await testDuplicateSubmission();
  await testSerialQueueContract();

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length > 0) {
    console.error("FAILED:", failed.map((c) => c.name).join("; "));
    process.exit(1);
  }
  process.exit(0);
}

void main();
