/**
 * Executable validation for T18:
 * "duplicate source/build submission does not create duplicate effective work".
 *
 * Imports the repository's REAL sources unmodified (Node built-in TS type
 * stripping + the .js->.ts resolve hook). No dependencies, no build step.
 *
 * Run from the workspace root:
 *   node --import ./.prale-eval/register-hook.mjs ./.prale-eval/validate.mjs
 */
import assert from "node:assert/strict";

import { BuildQueue } from "../MemoryKnowledge/src/store/build-queue.ts";
import { CodeGraphService } from "../MemoryKnowledge/src/store/code-graph-service.ts";

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      results.push([true, name]);
      console.log(`PASS  ${name}`);
    })
    .catch((err) => {
      results.push([false, name]);
      console.log(`FAIL  ${name}\n      ${err?.message ?? err}`);
    });
}

// ── Part A: BuildQueue is a per-asset-key serial lane ───────────────────────
// Duplicate submissions for the SAME key are queued onto one SerialQueue, so
// their bodies can never overlap (no duplicate concurrent effective work on
// git / SQLite / files). Distinct keys get independent lanes.

function trackedJob(state, holdMs) {
  return () =>
    new Promise((resolve) => {
      state.active += 1;
      state.max = Math.max(state.max, state.active);
      state.starts += 1;
      setTimeout(() => {
        state.active -= 1;
        resolve();
      }, holdMs);
    });
}

await check("BuildQueue: same-key duplicate submission never overlaps (max concurrency = 1)", async () => {
  const q = new BuildQueue();
  const state = { active: 0, max: 0, starts: 0 };
  q.enqueue("cg-dup", trackedJob(state, 15));
  q.enqueue("cg-dup", trackedJob(state, 15));
  await q.onIdle();
  assert.equal(state.max, 1, `overlap observed: max=${state.max}`);
  assert.equal(state.starts, 2, "both queued jobs must still run (serialized, not dropped)");
});

await check("BuildQueue: distinct asset keys get independent lanes (concurrency can be 2)", async () => {
  const q = new BuildQueue();
  const state = { active: 0, max: 0, starts: 0 };
  q.enqueue("cg-a", trackedJob(state, 20));
  q.enqueue("cg-b", trackedJob(state, 20));
  await q.onIdle();
  assert.equal(state.max, 2, `lanes are not independent: max=${state.max}`);
});

await check("BuildQueue: onIdle(key) resolves only after that key's queue drains", async () => {
  const q = new BuildQueue();
  let done = false;
  q.enqueue("cg-x", async () => {
    await new Promise((r) => setTimeout(r, 10));
    done = true;
  });
  await q.onIdle("cg-x");
  assert.equal(done, true);
});

// ── Part B: service-level dedupe of duplicate submissions ───────────────────
// Real CodeGraphService wired to a minimal in-memory IKnowledgeStore that
// mirrors the identity semantics of SqliteKnowledgeStore.createCodeGraph:
// identity key = (service_id, team_id, repo_url, branch).

function makeFakeStore() {
  const rows = new Map(); // code_graph_id -> row
  let seq = 0;
  const identity = (i) => `${i.service_id}|${i.team_id}|${i.repo_url}|${i.branch}`;
  return {
    audits: [],
    createCodeGraph(input) {
      const key = identity(input);
      for (const row of rows.values()) {
        if (row._key === key && row.deleted_at == null) return { row, existed: true };
      }
      const row = {
        _key: key,
        code_graph_id: `cg-${++seq}`,
        service_id: input.service_id,
        team_id: input.team_id,
        repo_name: input.repo_name ?? "",
        repo_url: input.repo_url,
        branch: input.branch,
        user_id: input.user_id ?? null,
        agent_id: input.agent_id ?? null,
        status: "pending",
        internal_status: null,
        sync_error: null,
        version: 1,
        deleted_at: null,
      };
      rows.set(row.code_graph_id, row);
      return { row, existed: false };
    },
    getCodeGraph(serviceId, teamId, id) {
      const row = rows.get(id);
      return row && row.service_id === serviceId && row.team_id === teamId && row.deleted_at == null
        ? row
        : null;
    },
    getCodeGraphById(serviceId, id) {
      const row = rows.get(id);
      return row && row.service_id === serviceId && row.deleted_at == null ? row : null;
    },
    updateCodeGraphStatus(serviceId, id, patch) {
      const row = rows.get(id);
      if (row) Object.assign(row, patch);
    },
    updateCodeGraphMeta(_s, id, patch) {
      const row = rows.get(id);
      if (row) Object.assign(row, patch);
      return row ?? null;
    },
    deleteCodeGraph(serviceId, teamId, id) {
      const row = rows.get(id);
      if (row && row.service_id === serviceId && row.team_id === teamId) rows.delete(id);
    },
    appendCodeGraphAudit(entry) {
      this.audits.push(entry);
    },
  };
}

await check("CodeGraphService: duplicate create is idempotent — one row, one effective build", async () => {
  const store = makeFakeStore();
  let workerRuns = 0;
  const svc = new CodeGraphService({
    store,
    dataRoot: new URL("./.tmp-data/", import.meta.url).pathname,
    worker: async () => {
      workerRuns += 1;
      await new Promise((r) => setTimeout(r, 10));
      return { commitHash: "deadbeef", stats: { files: 1, nodes: 1, edges: 0 } };
    },
  });
  const params = {
    service_id: "svc-1",
    team_id: "team-1",
    repo_url: "https://example.invalid/repo.git",
    branch: "main",
    user_id: "u-1",
  };

  const first = svc.create(params);
  const second = svc.create(params); // duplicate submission, same identity

  assert.equal(first.existed, false, "first create must be a new row");
  assert.equal(second.existed, true, "duplicate create must report existed=true");
  assert.equal(second.row.code_graph_id, first.row.code_graph_id, "duplicate must reuse the same asset id");

  await svc.onIdle();
  assert.equal(workerRuns, 1, `duplicate create triggered ${workerRuns} builds (expected 1)`);
  assert.equal(first.row.status, "ready");
});

await check("CodeGraphService: sync during in-flight build returns busy and enqueues nothing", async () => {
  const store = makeFakeStore();
  let workerRuns = 0;
  const svc = new CodeGraphService({
    store,
    dataRoot: new URL("./.tmp-data/", import.meta.url).pathname,
    worker: async () => {
      workerRuns += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { stats: { files: 1, nodes: 1, edges: 0 } };
    },
  });
  const { row } = svc.create({
    service_id: "svc-2",
    team_id: "team-2",
    repo_url: "https://example.invalid/repo2.git",
    branch: "main",
  });

  const dup = svc.sync("svc-2", "team-2", row.code_graph_id);
  assert.equal(dup.kind, "busy", `duplicate sync must be rejected as busy, got ${dup.kind}`);

  await svc.onIdle();
  assert.equal(workerRuns, 1, `duplicate sync triggered ${workerRuns} builds (expected 1)`);

  // A later sync of a finished asset is a legitimate new build (version+1), not duplication.
  const legit = svc.sync("svc-2", "team-2", row.code_graph_id);
  assert.equal(legit.kind, "ok");
  assert.equal(legit.row.version, 2);
  await svc.onIdle();
  assert.equal(workerRuns, 2, "explicit post-ready sync is a new versioned rebuild");
});

const failed = results.filter(([ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
