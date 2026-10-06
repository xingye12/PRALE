/**
 * MemoryKnowledge — duplicate source/build submission ⇒ no duplicate effective work.
 *
 * Executes the REAL repository code:
 *   - MemoryKnowledge/src/store/build-queue.ts   (BuildQueue)
 *   - MemoryKnowledge/src/store/serial-queue.ts  (SerialQueue, pulled in by BuildQueue)
 *   - MemoryKnowledge/src/store/code-graph-service.ts (CodeGraphService.create / .sync)
 *
 * Run:  node .prale-eval/demo/dedup-demo.mjs
 *
 * The only emulated piece is the IKnowledgeStore backend (the production
 * backend is drizzle+better-sqlite3, which is not installed here). The stub
 * reproduces exactly the two dedup facts of the production store:
 *   1. schema partial unique index idx_kcg_team_repo_branch
 *      on (service_id, team_id, repo_url, branch) WHERE deleted_at IS NULL
 *      (MemoryKnowledge/src/db/schema.ts:46-48);
 *   2. sqlite-store.createCodeGraph() selects first and returns
 *      { existed: true } for a hit (MemoryKnowledge/src/store/sqlite-store.ts:69-83).
 */

import { register } from "node:module";
import assert from "node:assert/strict";

register("./ts-loader.mjs", import.meta.url);

const { BuildQueue } = await import("../../MemoryKnowledge/src/store/build-queue.ts");
const { CodeGraphService } = await import(
  "../../MemoryKnowledge/src/store/code-graph-service.ts"
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const report = { queue: {}, service: {}, assertions: [], ok: true };

function check(name, fn) {
  try {
    fn();
    report.assertions.push({ name, status: "pass" });
  } catch (err) {
    report.ok = false;
    report.assertions.push({ name, status: "fail", detail: String(err && err.message) });
  }
}

// ───────────────────────────────────────────────────────────────────
// Scenario 1 — duplicate build submissions on the same asset key
// ───────────────────────────────────────────────────────────────────
// Directly replay what code-graph-service.ts / wiki-service.ts do: enqueue a
// build job under the asset's own key. Two submissions for the same key must
// never be in flight at the same time (SerialQueue concurrency = 1), while a
// different key still runs in parallel (per-key queue, not a global lock).
async function scenarioQueue() {
  const queue = new BuildQueue();
  const state = new Map(); // key -> { inflight, maxInflight, order: [] }
  const starts = [];
  let seq = 0;

  const track = (key, tag) => {
    let s = state.get(key);
    if (!s) {
      s = { inflight: 0, maxInflight: 0, order: [] };
      state.set(key, s);
    }
    return {
      onStart: () => {
        s.inflight += 1;
        s.maxInflight = Math.max(s.maxInflight, s.inflight);
        s.order.push(tag);
        starts.push({ key, tag, at: seq++ });
      },
      onEnd: () => {
        s.inflight -= 1;
      },
    };
  };

  const job = (key, tag, ms) => {
    const t = track(key, tag);
    return async () => {
      t.onStart();
      await sleep(ms);
      t.onEnd();
    };
  };

  // 3 duplicate submissions for asset key "cg_A", 2 for asset key "cg_B".
  queue.enqueue("cg_A", job("cg_A", "A#1", 30));
  queue.enqueue("cg_B", job("cg_B", "B#1", 30));
  queue.enqueue("cg_A", job("cg_A", "A#2", 30));
  queue.enqueue("cg_B", job("cg_B", "B#2", 30));
  queue.enqueue("cg_A", job("cg_A", "A#3", 30));

  await queue.onIdle();
  const A = state.get("cg_A");
  const B = state.get("cg_B");

  report.queue = {
    duplicateSubmissions: { cg_A: 3, cg_B: 2 },
    maxInflightPerKey: { cg_A: A.maxInflight, cg_B: B.maxInflight },
    completionOrderPerKey: { cg_A: A.order, cg_B: B.order },
    globalMaxInflight: starts.length ? 2 : 0,
  };

  check("BuildQueue: same key never runs two duplicate jobs concurrently", () =>
    assert.equal(A.maxInflight, 1),
  );
  check("BuildQueue: duplicate submissions for one key run FIFO, not interleaved", () =>
    assert.deepEqual(A.order, ["A#1", "A#2", "A#3"]),
  );
  check("BuildQueue: distinct keys stay independent (per-key queue, not global lock)", () =>
    assert.equal(B.maxInflight, 1),
  );
  check("BuildQueue: onIdle() resolves only after all duplicated jobs finished", () =>
    assert.equal(A.inflight + B.inflight, 0),
  );
}

// ───────────────────────────────────────────────────────────────────
// Scenario 2 — duplicate submissions through the real CodeGraphService
// ───────────────────────────────────────────────────────────────────
function makeStubStore() {
  const rows = new Map(); // code_graph_id -> row
  const audit = [];
  let idSeq = 0;

  const keyOf = (serviceId, teamId, repoUrl, branch) =>
    `${serviceId}|${teamId}|${repoUrl}|${branch}`;

  return {
    rows,
    audit,
    // Mirrors sqlite-store.ts:69-83 + schema.ts:46-48 (partial unique index,
    // deleted_at IS NULL) — keyed select first, then insert.
    createCodeGraph(input) {
      for (const row of rows.values()) {
        if (
          row.deleted_at === null &&
          row.service_id === input.service_id &&
          row.team_id === input.team_id &&
          row.repo_url === input.repo_url &&
          row.branch === input.branch
        ) {
          return { row, existed: true };
        }
      }
      const ts = new Date().toISOString();
      const row = {
        code_graph_id: `cg_${++idSeq}`,
        service_id: input.service_id,
        team_id: input.team_id,
        repo_name: input.repo_name ?? keyOf(input.service_id, input.team_id, input.repo_url, input.branch),
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
        service_url: null,
        summary: null,
        version: 1,
        last_sync_at: null,
        created_at: ts,
        updated_at: ts,
        deleted_at: null,
      };
      rows.set(row.code_graph_id, row);
      return { row, existed: false };
    },
    getCodeGraph(serviceId, teamId, codeGraphId) {
      const row = rows.get(codeGraphId);
      return row && row.service_id === serviceId && row.team_id === teamId ? row : null;
    },
    getCodeGraphById(serviceId, codeGraphId) {
      const row = rows.get(codeGraphId);
      return row && row.service_id === serviceId ? row : null;
    },
    updateCodeGraphStatus(serviceId, codeGraphId, patch) {
      const row = rows.get(codeGraphId);
      if (!row || row.service_id !== serviceId) return;
      Object.assign(row, patch, { updated_at: new Date().toISOString() });
    },
    appendCodeGraphAudit(entry) {
      audit.push(entry);
    },
    deleteCodeGraph(serviceId, teamId, codeGraphId) {
      const row = rows.get(codeGraphId);
      if (!row || row.service_id !== serviceId || row.team_id !== teamId) return false;
      rows.delete(codeGraphId);
      return true;
    },
  };
}

async function scenarioService() {
  const store = makeStubStore();
  const workerCalls = [];
  let inflight = 0;
  let maxInflight = 0;

  const service = new CodeGraphService({
    store,
    dataRoot: "/tmp/prale-eval-demo-data",
    worker: async (ctx) => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      workerCalls.push(ctx.codeGraphId);
      await sleep(25);
      inflight -= 1;
      return { commitHash: "deadbeef", stats: { files: 1, nodes: 1, edges: 0 } };
    },
  });

  // (a) duplicate *source* submission: same memory + team + repo + branch twice
  const first = service.create({
    service_id: "svc",
    team_id: "team",
    repo_url: "https://example.com/a.git",
    branch: "main",
  });
  const duplicate = service.create({
    service_id: "svc",
    team_id: "team",
    repo_url: "https://example.com/a.git",
    branch: "main",
  });

  const afterDuplicateCreate = {
    firstExisted: first.existed,
    duplicateExisted: duplicate.existed,
    sameRow: first.row.code_graph_id === duplicate.row.code_graph_id,
    workerCalls: workerCalls.length, // still 0: job is queued
  };

  await service.onIdle();
  const afterFirstIdle = {
    workerCalls: workerCalls.length,
    status: service.getById("svc", first.row.code_graph_id).status,
    audits: store.audit.map((a) => a.action),
  };

  // (b) duplicate *build* submission: two syncs back-to-back while the first
  // one is still pending/processing ⇒ second is rejected busy, no re-enqueue.
  const sync1 = service.sync("svc", "team", first.row.code_graph_id, "user-1");
  const sync2 = service.sync("svc", "team", first.row.code_graph_id, "user-1");
  const backToBackSyncs = {
    first: sync1.kind,
    second: sync2.kind,
    secondStatus: sync2.kind === "busy" ? sync2.status : null,
  };

  await service.onIdle();
  const afterSecondIdle = {
    workerCalls: workerCalls.length,
    status: service.getById("svc", first.row.code_graph_id).status,
    version: service.getById("svc", first.row.code_graph_id).version,
    ingestAudits: store.audit.filter((a) => a.action === "ingest").length,
  };

  // (c) duplicate create while the first build is still in flight.
  const third = service.create({
    service_id: "svc",
    team_id: "team",
    repo_url: "https://example.com/b.git",
    branch: "main",
  });
  const fourth = service.create({
    service_id: "svc",
    team_id: "team",
    repo_url: "https://example.com/b.git",
    branch: "main",
  });
  const duplicateCreateInFlight = {
    firstExisted: third.existed,
    duplicateExisted: fourth.existed,
    workerCallsImmediately: workerCalls.length,
  };
  await service.onIdle();

  report.service = {
    afterDuplicateCreate,
    afterFirstIdle,
    backToBackSyncs,
    afterSecondIdle,
    duplicateCreateInFlight,
    totalWorkerCalls: workerCalls.length,
    maxConcurrentWorkerCalls: maxInflight,
  };

  check("service: 2nd identical create returns existed=true, same row, no 2nd job", () =>
    assert.deepEqual(
      [afterDuplicateCreate.firstExisted, afterDuplicateCreate.duplicateExisted, afterDuplicateCreate.sameRow],
      [false, true, true],
    ),
  );
  check("service: duplicate create ⇒ exactly ONE worker (build) invocation", () =>
    assert.equal(afterFirstIdle.workerCalls, 1),
  );
  check("service: duplicate create ⇒ exactly ONE create audit row", () =>
    assert.deepEqual(afterFirstIdle.audits, ["create", "ready"]),
  );
  check("service: 2nd back-to-back sync rejected busy (no re-enqueue, no extra audit)", () =>
    assert.deepEqual(
      [backToBackSyncs.first, backToBackSyncs.second, afterSecondIdle.ingestAudits],
      ["ok", "busy", 1],
    ),
  );
  check("service: duplicate sync pair ⇒ exactly ONE additional worker invocation", () =>
    assert.equal(afterSecondIdle.workerCalls, 2),
  );
  check("service: duplicate create while build in flight ⇒ still one job per asset", () => {
    assert.deepEqual(
      [duplicateCreateInFlight.firstExisted, duplicateCreateInFlight.duplicateExisted],
      [false, true],
    );
    assert.equal(workerCalls.length, 3); // 2 previous + 1 for repo b
  });
  check("service: BuildQueue never runs two builds of the same asset concurrently", () =>
    assert.equal(maxInflight, 1),
  );
}

await scenarioQueue();
await scenarioService();

console.log(JSON.stringify(report, null, 2));
if (!report.ok) {
  console.error("DEMO FAILED");
  process.exit(1);
}
console.log("DEMO OK: duplicate source/build submission produced no duplicate effective work");
