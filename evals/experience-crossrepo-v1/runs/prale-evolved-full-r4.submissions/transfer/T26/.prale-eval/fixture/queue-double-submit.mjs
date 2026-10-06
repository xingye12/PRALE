/**
 * Queue fixture — "same source submitted twice" contract.
 *
 * Drives the REAL repository modules (no copies, no re-implementation):
 *   - MemoryKnowledge/src/store/build-queue.ts      (BuildQueue: per-key serial queue)
 *   - MemoryKnowledge/src/store/serial-queue.ts     (SerialQueue: concurrency=1)
 *   - MemoryKnowledge/src/store/code-graph-service.ts (idempotent create + pending/processing guard)
 *
 * Contract under test:
 *   Submitting the SAME source (same service/team/repo_url/branch, i.e. the same
 *   BuildQueue key) twice must produce exactly ONE effective build, and that build
 *   must walk pending -> processing -> ready and record the `ready` terminal state.
 *
 * Run:
 *   node --experimental-strip-types .prale-eval/fixture/queue-double-submit.mjs
 *
 * Exit code 0 = every assertion passed; 1 = at least one failed (details on stdout).
 */

import { register } from "node:module";

register(new URL("./ts-resolve.mjs", import.meta.url).href);

const { BuildQueue } = await import("../../MemoryKnowledge/src/store/build-queue.ts");
const { SerialQueue } = await import("../../MemoryKnowledge/src/store/serial-queue.ts");
const { CodeGraphService } = await import("../../MemoryKnowledge/src/store/code-graph-service.ts");

const results = [];
const check = (name, condition, detail) => {
  results.push({ name, pass: Boolean(condition), detail });
};

// ─────────────────────────────────────────────────────────────────────────────
// Minimal in-memory IKnowledgeStore (code-graph subset used by CodeGraphService).
// Mirrors sqlite-store's idempotency key: (service_id, team_id, repo_url, branch).
// ─────────────────────────────────────────────────────────────────────────────
function makeStore() {
  const byKey = new Map();
  const byId = new Map();
  const audits = [];
  let seq = 0;
  const now = () => new Date().toISOString();
  const clone = (r) => (r ? { ...r } : null);

  return {
    _audits: audits,
    _byId: byId,
    createCodeGraph(input) {
      const key = [input.service_id, input.team_id, input.repo_url, input.branch].join("|");
      const existing = byKey.get(key);
      if (existing) return { row: clone(existing), existed: true }; // idempotent hit
      const ts = now();
      const row = {
        code_graph_id: `cg-${++seq}`,
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
      byKey.set(key, row);
      byId.set(row.code_graph_id, row);
      return { row: clone(row), existed: false };
    },
    getCodeGraph(serviceId, teamId, id) {
      const r = byId.get(id);
      if (!r || r.service_id !== serviceId || r.team_id !== teamId || r.deleted_at !== null) return null;
      return clone(r);
    },
    getCodeGraphById(serviceId, id) {
      const r = byId.get(id);
      if (!r || r.service_id !== serviceId || r.deleted_at !== null) return null;
      return clone(r);
    },
    listCodeGraphs(serviceId, teamId) {
      return [...byKey.values()]
        .filter((r) => r.service_id === serviceId && r.team_id === teamId && r.deleted_at === null)
        .map(clone);
    },
    countCodeGraphs(serviceId, teamId) {
      return this.listCodeGraphs(serviceId, teamId).length;
    },
    updateCodeGraphStatus(serviceId, id, patch) {
      const r = byId.get(id);
      if (!r || r.service_id !== serviceId) return;
      Object.assign(r, patch, { updated_at: now() });
    },
    updateCodeGraphMeta(serviceId, id, patch) {
      const r = byId.get(id);
      if (!r || r.service_id !== serviceId) return null;
      Object.assign(r, patch, { updated_at: now() });
      return clone(r);
    },
    deleteCodeGraph(serviceId, teamId, id) {
      const r = byId.get(id);
      if (!r || r.service_id !== serviceId || r.team_id !== teamId) return false;
      byId.delete(id);
      for (const [k, v] of byKey) if (v === r) byKey.delete(k);
      return true;
    },
    appendCodeGraphAudit(input) {
      audits.push({ ...input, created_at: now() });
    },
    listCodeGraphAudit(serviceId, id) {
      return audits.filter((a) => a.service_id === serviceId && a.asset_id === id);
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PART 1 — BuildQueue mechanical contract (per-key serial execution)
// ─────────────────────────────────────────────────────────────────────────────
{
  const queue = new BuildQueue();
  // Per-key concurrency: BuildQueue gives each key its own SerialQueue, so jobs
  // sharing a key must serialize while distinct keys may overlap.
  const activeByKey = new Map();
  const maxByKey = new Map();
  let globalMaxActive = 0;
  let globalActive = 0;
  const order = [];
  const job = (tag, key, ms) => async () => {
    const n = (activeByKey.get(key) ?? 0) + 1;
    activeByKey.set(key, n);
    maxByKey.set(key, Math.max(maxByKey.get(key) ?? 0, n));
    globalActive += 1;
    globalMaxActive = Math.max(globalMaxActive, globalActive);
    order.push(`start:${tag}`);
    await new Promise((r) => setTimeout(r, ms));
    order.push(`end:${tag}`);
    activeByKey.set(key, activeByKey.get(key) - 1);
    globalActive -= 1;
  };

  queue.enqueue("same-source", job("a", "same-source", 25));
  queue.enqueue("same-source", job("b", "same-source", 5));
  queue.enqueue("other-source", job("c", "other-source", 5));
  await queue.onIdle();

  check(
    "BuildQueue: same key never runs two jobs concurrently",
    maxByKey.get("same-source") === 1,
    `max concurrent jobs for key 'same-source' = ${maxByKey.get("same-source")}`,
  );
  check(
    "BuildQueue: distinct keys get independent queues and may overlap",
    globalMaxActive === 2,
    `global max concurrent jobs = ${globalMaxActive}`,
  );
  check(
    "BuildQueue: same-key jobs run in FIFO order (a fully before b)",
    order.indexOf("end:a") < order.indexOf("start:b"),
    `order = ${order.join(", ")}`,
  );
  check(
    "BuildQueue: onIdle() drains every key's queue",
    order.length === 6,
    `completed events = ${order.length}/6`,
  );

  // onIdle(key) waits only for that key; a fresh BuildQueue reuses one SerialQueue
  // instance per key (the Map in build-queue.ts:12-20), so the queue is keyed, not global.
  const q2 = new BuildQueue();
  let a1Done = false;
  let b1Done = false;
  q2.enqueue("k1", async () => {
    await new Promise((r) => setTimeout(r, 15));
    a1Done = true;
  });
  q2.enqueue("k2", async () => {
    await new Promise((r) => setTimeout(r, 15));
    b1Done = true;
  });
  await q2.onIdle("k1");
  check(
    "BuildQueue: onIdle(key) resolves after that key's job",
    a1Done === true,
    `k1 job completed = ${a1Done}`,
  );
  await q2.onIdle();
  check(
    "BuildQueue: global onIdle() also waits for other keys",
    a1Done && b1Done,
    `k1=${a1Done}, k2=${b1Done}`,
  );

  // SerialQueue is the concurrency=1 primitive BuildQueue is built from.
  const sq = new SerialQueue("probe");
  const sqOrder = [];
  const p1 = sq.add(async () => {
    sqOrder.push("1");
    return "one";
  });
  const p2 = sq.add(async () => {
    sqOrder.push("2");
    return "two";
  });
  const [r1, r2] = await Promise.all([p1, p2]);
  check(
    "SerialQueue: add() returns each task's result in FIFO order",
    r1 === "one" && r2 === "two" && sqOrder.join(",") === "1,2",
    `results = ${r1}/${r2}, order = ${sqOrder.join(",")}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PART 2 — Same source submitted twice => ONE effective build + terminal state
// ─────────────────────────────────────────────────────────────────────────────
{
  const store = makeStore();
  const queue = new BuildQueue();
  const workerCalls = [];
  const worker = async (ctx) => {
    workerCalls.push({ at: Date.now(), codeGraphId: ctx.codeGraphId, dir: ctx.dir });
    ctx.setInternalStatus("indexing");
    await new Promise((r) => setTimeout(r, 20));
    return { commitHash: "abc1234", stats: { files: 7, nodes: 42, edges: 88 } };
  };

  const service = new CodeGraphService({
    store,
    dataRoot: "/tmp/prale-fixture-data",
    worker,
    queue,
  });

  const source = {
    service_id: "svc-a",
    team_id: "team-1",
    repo_url: "https://example.com/acme/tdam.git",
    branch: "main",
    repo_name: "tdam",
  };

  // Submission #1
  const first = service.create(source);
  // Submission #2 — SAME source, before the first build has finished.
  const second = service.create(source);
  // Submission #3 — the other duplicate-submit route: explicit sync while in-flight.
  const syncWhilePending = service.sync(source.service_id, source.team_id, first.row.code_graph_id);

  check("submit#1 created a new row", first.existed === false, `existed=${first.existed}`);
  check(
    "submit#2 (same source) is an idempotent hit, not a new row",
    second.existed === true,
    `existed=${second.existed}`,
  );
  check(
    "both submissions resolve to the SAME code_graph_id",
    second.row.code_graph_id === first.row.code_graph_id,
    `${first.row.code_graph_id} vs ${second.row.code_graph_id}`,
  );
  check(
    "duplicate sync while in-flight is rejected as busy",
    syncWhilePending.kind === "busy",
    `sync result = ${JSON.stringify(syncWhilePending)}`,
  );
  check(
    "at submit time the row is non-terminal (pending/processing)",
    second.row.status === "pending" || second.row.status === "processing",
    `status=${second.row.status}`,
  );

  await service.onIdle();

  const rows = store.listCodeGraphs(source.service_id, source.team_id);
  const final = service.getById(source.service_id, first.row.code_graph_id);

  check(
    "ONE effective build: exactly one row for the duplicated source",
    rows.length === 1,
    `rows=${rows.length}`,
  );
  check(
    "ONE effective build: worker invoked exactly once",
    workerCalls.length === 1,
    `worker invocations=${workerCalls.length}`,
  );
  check(
    "terminal state recorded: status === 'ready'",
    final.status === "ready",
    `status=${final.status}`,
  );
  check(
    "terminal state recorded: internal_status cleared to null",
    final.internal_status === null,
    `internal_status=${final.internal_status}`,
  );
  check(
    "terminal state recorded: sync_error is null",
    final.sync_error === null,
    `sync_error=${final.sync_error}`,
  );
  check(
    "terminal state recorded: worker result persisted (commit_hash + stats_json)",
    final.commit_hash === "abc1234" && final.stats_json === JSON.stringify({ files: 7, nodes: 42, edges: 88 }),
    `commit_hash=${final.commit_hash}, stats_json=${final.stats_json}`,
  );
  check(
    "terminal state recorded: last_sync_at timestamp set",
    typeof final.last_sync_at === "string" && final.last_sync_at.length > 0,
    `last_sync_at=${final.last_sync_at}`,
  );
  check(
    "version is unchanged by the duplicate submission (no rebuild)",
    final.version === 1,
    `version=${final.version}`,
  );

  const actions = store._audits.map((a) => a.action);
  check(
    "audit trail: one 'create' + one 'ready' (no duplicate build audit)",
    actions.filter((a) => a === "create").length === 1 && actions.filter((a) => a === "ready").length === 1,
    `audit actions = ${actions.join(", ")}`,
  );

  // Negative control: a genuinely different source gets its own row + its own build.
  const other = service.create({ ...source, branch: "release" });
  await service.onIdle();
  check(
    "negative control: a different source still builds independently",
    other.existed === false &&
      store.listCodeGraphs(source.service_id, source.team_id).length === 2 &&
      workerCalls.length === 2,
    `existed=${other.existed}, rows=${store.listCodeGraphs(source.service_id, source.team_id).length}, workerCalls=${workerCalls.length}`,
  );

  // Positive control: after the terminal state, an explicit sync is accepted again.
  const resync = service.sync(source.service_id, source.team_id, first.row.code_graph_id);
  check(
    "positive control: sync on a ready asset is accepted (busy guard is in-flight only)",
    resync.kind === "ok" && resync.row.version === 2,
    `sync result = ${JSON.stringify(resync)}`,
  );
  await service.onIdle();
  check(
    "re-build after terminal state still lands on 'ready'",
    service.getById(source.service_id, first.row.code_graph_id).status === "ready",
    `status=${service.getById(source.service_id, first.row.code_graph_id).status}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.pass);
console.log(
  JSON.stringify(
    {
      fixture: "queue-double-submit",
      module_under_test: "MemoryKnowledge/src/store/build-queue.ts",
      total: results.length,
      passed: results.length - failed.length,
      failed: failed.length,
      checks: results,
    },
    null,
    2,
  ),
);

if (failed.length > 0) {
  console.error(`\n${failed.length} CHECK(S) FAILED`);
  process.exit(1);
}
console.log("\nALL CHECKS PASSED");
