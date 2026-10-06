/**
 * Contract fixture: **the same source submitted twice yields one effective build**.
 *
 * Companion to `MemoryKnowledge/src/store/build-queue.ts`. The required
 * evidence for this task is that file, so the fixture drives it through the
 * real `CodeGraphService` (which owns the per-asset-key `BuildQueue`).
 *
 * What is contracted here
 * -----------------------
 * A "source" is a code-graph source identity: (service_id, team_id, repo_url,
 * branch). Submitting that same source twice must not fan out into two builds:
 *
 *   1. `create()` twice, sequentially
 *        → 2nd call is absorbed (`existed: true`, same code_graph_id)
 *        → worker executes exactly once
 *        → exactly one metadata row exists
 *        → the row records the terminal state: pending → processing → ready,
 *          version 1, commit_hash + last_sync_at + stats_json written.
 *   2. `create()` then `sync()` while the first build is still in flight
 *        → the duplicate submission is rejected with `{ kind: "busy" }`
 *          (no status overwrite, no second enqueue, no second audit row)
 *        → worker still executes exactly once per generation
 *        → row still terminates `ready` at version 1.
 *   3. Raw `BuildQueue` semantics that make (1) and (2) safe
 *        → same key ⇒ strictly serial (never concurrent), different keys ⇒
 *          independent queues that may run concurrently.
 *
 * Run with the repo's plain Node toolchain (no dependencies required):
 *
 *   cd MemoryKnowledge
 *   node --import ./test/contracts/queue-duplicate-source/register.mjs \
 *        --test ./test/contracts/queue-duplicate-source/duplicate-source.contract.mjs
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Real production sources (Node type-stripping + the register.mjs resolve hook).
import { BuildQueue } from "../../../src/store/build-queue.ts";
import { CodeGraphService } from "../../../src/store/code-graph-service.ts";

const SERVICE_ID = "svc-queue-fixture";
const TEAM_ID = "team-queue-fixture";
const REPO_URL = "https://example.invalid/tdam/queue-fixture-repo.git";
const BRANCH = "main";

/** The single source identity submitted twice in every scenario below. */
function sourceParams(over = {}) {
  return {
    service_id: SERVICE_ID,
    team_id: TEAM_ID,
    repo_url: REPO_URL,
    branch: BRANCH,
    repo_name: "queue-fixture-repo",
    user_id: "user-queue-fixture",
    ...over,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Minimal in-memory `IKnowledgeStore` covering exactly the surface
 * `CodeGraphService` uses. It mirrors the real SQLite contract that matters
 * here: `createCodeGraph` is idempotent on (service_id, team_id, repo_url,
 * branch) — see `SqliteKnowledgeStore.createCodeGraph`.
 */
function createMemoryStore() {
  /** @type {Map<string, any>} */
  const rows = new Map();
  /** @type {Map<string, string>} */
  const bySource = new Map();
  /** @type {any[]} */
  const audits = [];
  /** @type {Array<{ from: string|null, to: string }>} */
  const statusLog = [];
  let seq = 0;

  const sourceKey = (sid, tid, url, branch) => [sid, tid, url, branch].join("\u0000");
  const nowIso = () => new Date().toISOString();

  const store = {
    createCodeGraph(input) {
      const key = sourceKey(input.service_id, input.team_id, input.repo_url, input.branch);
      const existingId = bySource.get(key);
      if (existingId) return { row: { ...rows.get(existingId) }, existed: true };

      seq += 1;
      const codeGraphId = `cg-fixture-${String(seq).padStart(3, "0")}`;
      const ts = nowIso();
      const row = {
        code_graph_id: codeGraphId,
        service_id: input.service_id,
        team_id: input.team_id,
        repo_name: input.repo_name ?? "",
        repo_url: input.repo_url,
        branch: input.branch,
        commit_hash: null,
        owner_user_id: input.owner_user_id ?? null,
        user_id: input.user_id ?? null,
        agent_id: input.agent_id ?? null,
        task_id: input.task_id ?? null,
        visibility: input.visibility ?? "team",
        status: "pending",
        internal_status: null,
        sync_error: null,
        stats_json: null,
        service_url: input.service_url ?? null,
        summary: null,
        version: 1,
        last_sync_at: null,
        created_at: ts,
        updated_at: ts,
        deleted_at: null,
      };
      rows.set(codeGraphId, row);
      bySource.set(key, codeGraphId);
      return { row: { ...row }, existed: false };
    },

    getCodeGraph(serviceId, teamId, codeGraphId) {
      const row = rows.get(codeGraphId);
      if (!row || row.service_id !== serviceId || row.team_id !== teamId) return null;
      return { ...row };
    },

    getCodeGraphById(serviceId, codeGraphId) {
      const row = rows.get(codeGraphId);
      if (!row || row.service_id !== serviceId) return null;
      return { ...row };
    },

    listCodeGraphs(serviceId, teamId) {
      return [...rows.values()]
        .filter((r) => r.service_id === serviceId && r.team_id === teamId)
        .map((r) => ({ ...r }));
    },

    countCodeGraphs(serviceId, teamId) {
      return store.listCodeGraphs(serviceId, teamId).length;
    },

    updateCodeGraphStatus(serviceId, codeGraphId, patch) {
      const row = rows.get(codeGraphId);
      if (!row || row.service_id !== serviceId) return;
      if (patch.status && patch.status !== row.status) {
        statusLog.push({ from: row.status, to: patch.status });
      }
      Object.assign(row, patch, { updated_at: nowIso() });
    },

    updateCodeGraphMeta(serviceId, codeGraphId, patch) {
      const row = rows.get(codeGraphId);
      if (!row || row.service_id !== serviceId) return null;
      Object.assign(row, patch, { updated_at: nowIso() });
      return { ...row };
    },

    deleteCodeGraph(serviceId, teamId, codeGraphId) {
      const row = rows.get(codeGraphId);
      if (!row || row.service_id !== serviceId || row.team_id !== teamId) return false;
      rows.delete(codeGraphId);
      bySource.delete(sourceKey(row.service_id, row.team_id, row.repo_url, row.branch));
      return true;
    },

    appendCodeGraphAudit(input) {
      audits.push({ ...input });
    },
  };

  return {
    store,
    audits,
    statusLog,
    all: () => [...rows.values()].map((r) => ({ ...r })),
  };
}

/** Worker double: counts invocations, tracks overlap, returns a fixed result. */
function createWorker({ delayMs = 10, gate = null } = {}) {
  const builds = [];
  const state = { inflight: 0, maxInflight: 0 };
  const worker = async (ctx) => {
    builds.push({ codeGraphId: ctx.codeGraphId, repoUrl: ctx.repoUrl, branch: ctx.branch });
    state.inflight += 1;
    state.maxInflight = Math.max(state.maxInflight, state.inflight);
    ctx.setInternalStatus("indexing");
    if (gate) await gate.promise;
    else await sleep(delayMs);
    state.inflight -= 1;
    return { commitHash: "fixture-sha-0001", stats: { files: 1, nodes: 2, edges: 1 } };
  };
  return { worker, builds, state };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeService(queue, worker) {
  const dataRoot = mkdtempSync(join(tmpdir(), "queue-fixture-"));
  const memory = createMemoryStore();
  const service = new CodeGraphService({ store: memory.store, dataRoot, worker, queue });
  return { service, ...memory };
}

// ── Scenario 1: same source submitted twice, sequentially ────────────────

async function scenarioDuplicateCreate() {
  const queue = new BuildQueue();
  const { worker, builds, state } = createWorker();
  const { service, audits, statusLog, all } = makeService(queue, worker);

  const first = service.create(sourceParams());
  const second = service.create(sourceParams()); // exact same source, again

  await service.onIdle();

  assert.equal(first.existed, false, "1st submission creates the asset");
  assert.equal(second.existed, true, "2nd submission is absorbed by the same row");
  assert.equal(
    second.row.code_graph_id,
    first.row.code_graph_id,
    "both submissions address one code_graph_id",
  );

  assert.equal(builds.length, 1, "exactly one effective build ran");
  assert.equal(state.maxInflight, 1, "the build never overlapped with itself");
  assert.equal(all().length, 1, "exactly one metadata row exists for the source");

  const row = service.get(SERVICE_ID, TEAM_ID, first.row.code_graph_id);
  assert.equal(row.status, "ready", "terminal state is ready");
  assert.equal(row.internal_status, null, "no internal step left dangling");
  assert.equal(row.sync_error, null, "no error recorded");
  assert.equal(row.version, 1, "version stays 1 — the duplicate did not re-open the build");
  assert.equal(row.commit_hash, "fixture-sha-0001", "build result persisted");
  assert.equal(row.stats_json, JSON.stringify({ files: 1, nodes: 2, edges: 1 }));
  assert.ok(row.last_sync_at, "last_sync_at recorded");
  assert.deepEqual(
    statusLog,
    [
      { from: "pending", to: "processing" },
      { from: "processing", to: "ready" },
    ],
    "recorded lifecycle is pending → processing → ready",
  );
  assert.deepEqual(
    audits.map((a) => a.action),
    ["create", "ready"],
    "audit trail has the create + single ready entry",
  );

  return {
    scenario: "duplicate_create",
    submissions: 2,
    assets_created: 1,
    effective_builds: builds.length,
    terminal_state: row.status,
    version: row.version,
    lifecycle: ["pending", "processing", "ready"],
    audit_actions: audits.map((a) => a.action),
  };
}

// ── Scenario 2: duplicate submitted while the first build is in flight ───

async function scenarioDuplicateWhileInFlight() {
  const queue = new BuildQueue();
  const gate = createDeferred();
  const { worker, builds } = createWorker({ gate });
  const { service, audits, all } = makeService(queue, worker);

  const created = service.create(sourceParams());
  // Let the queued job reach `processing` before the duplicate arrives.
  await sleep(0);
  const inFlight = service.get(SERVICE_ID, TEAM_ID, created.row.code_graph_id);
  assert.equal(inFlight.status, "processing", "first build is in flight");

  const duplicate = service.sync(SERVICE_ID, TEAM_ID, created.row.code_graph_id);
  assert.equal(duplicate.kind, "busy", "duplicate submission is rejected, not queued");
  assert.equal(duplicate.status, "processing", "busy reason is the live status");
  assert.equal(duplicate.step, "indexing", "busy reports the current internal step");

  gate.resolve();
  await service.onIdle();

  assert.equal(builds.length, 1, "still exactly one effective build for the generation");
  assert.equal(all().length, 1, "no duplicate row was created");
  assert.deepEqual(
    audits.map((a) => a.action),
    ["create", "ready"],
    "the rejected duplicate wrote no sync/audit row",
  );

  const row = service.get(SERVICE_ID, TEAM_ID, created.row.code_graph_id);
  assert.equal(row.status, "ready", "terminal state is ready");
  assert.equal(row.version, 1, "rejected duplicate did not bump the version");

  return {
    scenario: "duplicate_while_in_flight",
    submissions: 2,
    accepted: 1,
    rejected: 1,
    rejection: { kind: duplicate.kind, status: duplicate.status, step: duplicate.step },
    effective_builds: builds.length,
    terminal_state: row.status,
    version: row.version,
  };
}

// ── Scenario 3: the queue contract that makes the dedup safe ─────────────

async function scenarioQueueSemantics() {
  const queue = new BuildQueue();
  /** same-key lane trace: must be strictly serial (never interleaved). */
  const sameKeyTrace = [];
  const crossKeyTrace = [];
  let sameKeyInflight = 0;
  let sameKeyMaxInflight = 0;

  const job = (tag, ms) => async () => {
    sameKeyInflight += 1;
    sameKeyMaxInflight = Math.max(sameKeyMaxInflight, sameKeyInflight);
    sameKeyTrace.push(`start:${tag}`);
    await sleep(ms);
    sameKeyTrace.push(`end:${tag}`);
    sameKeyInflight -= 1;
  };

  // Same key twice → one serial lane, never concurrent.
  queue.enqueue("cg-fixture-001", job("same-key-1", 20));
  queue.enqueue("cg-fixture-001", job("same-key-2", 20));

  // Different keys → independent lanes that may run at the same time.
  const gateA = createDeferred();
  const gateB = createDeferred();
  let started = 0;
  const gated = (d, tag) => async () => {
    started += 1;
    crossKeyTrace.push(`start:${tag}`);
    await d.promise;
    crossKeyTrace.push(`end:${tag}`);
  };
  queue.enqueue("cg-fixture-002", gated(gateA, "other-key-1"));
  queue.enqueue("cg-fixture-003", gated(gateB, "other-key-2"));
  await sleep(0);
  const crossKeyConcurrent = started === 2;
  gateA.resolve();
  gateB.resolve();

  await queue.onIdle();
  await queue.onIdle("cg-fixture-001");

  assert.deepEqual(
    sameKeyTrace,
    ["start:same-key-1", "end:same-key-1", "start:same-key-2", "end:same-key-2"],
    "same key is strictly serial (FIFO, concurrency 1)",
  );
  assert.equal(sameKeyMaxInflight, 1, "same key never overlaps with itself");
  assert.equal(sameKeyInflight, 0, "same-key lane drained");
  assert.deepEqual(
    crossKeyTrace.sort(),
    ["end:other-key-1", "end:other-key-2", "start:other-key-1", "start:other-key-2"].sort(),
    "different keys were both started (and finished)",
  );
  assert.ok(crossKeyConcurrent, "different keys run on independent queues");

  return {
    scenario: "queue_semantics",
    same_key_lifecycle: sameKeyTrace,
    same_key_max_concurrency: sameKeyMaxInflight,
    different_keys_run_concurrently: crossKeyConcurrent,
    lanes: ["cg-fixture-001", "cg-fixture-002", "cg-fixture-003"],
  };
}

// ── Aggregate contract entrypoint ───────────────────────────────────────

export async function runDuplicateSourceContract() {
  const scenarios = [
    await scenarioDuplicateCreate(),
    await scenarioDuplicateWhileInFlight(),
    await scenarioQueueSemantics(),
  ];
  const duplicateCreate = scenarios[0];
  return {
    contract: "queue-duplicate-source",
    source: sourceParams(),
    scenarios,
    normalized: {
      submissions_of_same_source: 2,
      effective_builds: duplicateCreate.effective_builds,
      metadata_rows: duplicateCreate.assets_created,
      terminal_state: duplicateCreate.terminal_state,
      version: duplicateCreate.version,
      lifecycle: duplicateCreate.lifecycle,
      audit_actions: duplicateCreate.audit_actions,
    },
  };
}

// Node's test runner sets NODE_TEST_CONTEXT in the spawned test file; `run.mjs`
// imports this module outside of the runner, where registering `test()` cases
// would just execute them a second time and pollute the JSON output.
if (process.env.NODE_TEST_CONTEXT) {
  test("same source submitted twice → one effective build reaching ready", async () => {
    const report = await runDuplicateSourceContract();
    assert.equal(report.normalized.effective_builds, 1);
    assert.equal(report.normalized.terminal_state, "ready");
  });

  test("duplicate submission while in flight is rejected as busy", async () => {
    const report = await scenarioDuplicateWhileInFlight();
    assert.equal(report.rejection.kind, "busy");
    assert.equal(report.effective_builds, 1);
  });

  test("BuildQueue is per-key serial and cross-key independent", async () => {
    const report = await scenarioQueueSemantics();
    assert.equal(report.same_key_max_concurrency, 1);
    assert.equal(report.different_keys_run_concurrently, true);
  });
}
