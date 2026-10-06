#!/usr/bin/env node
/**
 * Executable contract demo (T14 / tdam / contract).
 *
 * Goal: prove with a FAKE client operation that
 *   (1) no success state is committed before the fake effect completes, and
 *   (2) failure stays observable (never silently converted into success).
 *
 * The two shapes below mirror real, cited MemoryCore semantics:
 *
 *  - `OperationGate` mirrors `TdaiCore.ensureSchedulerStarted()`
 *    (MemoryCore/src/core/tdai-core.ts:1187-1217): a plain boolean is unsafe
 *    because it can be flipped *before* the awaited effect finishes, so the
 *    in-flight promise itself is stored as the success sentinel and cleared on
 *    rejection so a later retry can run.
 *
 *  - `CoalescingFakeClient` mirrors `CachedCredentialProvider.getCosCredential()`
 *    /`refresh()` (MemoryCore/src/core/storage/credential-provider.ts:105-167):
 *    concurrent callers coalesce on one in-flight fetch, `this.cached` is only
 *    assigned AFTER `await this.fetcher()` resolves, and a failed fetch is
 *    re-thrown when there is no stale fallback.
 *
 * Dependency-free: runs with plain `node`, no install required.
 *
 * Usage: node .prale-eval/contract/fake-client-operation.test.mjs
 */

import assert from "node:assert/strict";

// ════════════════════════════════════════════════════════════
// Test harness
// ════════════════════════════════════════════════════════════

const results = [];
let fired = 0;

async function testCase(name, fn) {
  fired += 1;
  const events = [];
  const record = (e) => events.push(e);
  try {
    await fn({ events, record });
    results.push({ case: name, outcome: "passed", events, pass: true });
  } catch (err) {
    results.push({
      case: name,
      outcome: "failed",
      events,
      error: err instanceof Error ? err.message : String(err),
      pass: false,
    });
  }
}

// ════════════════════════════════════════════════════════════
// The fake effect: a controllable async operation
// ════════════════════════════════════════════════════════════

class FakeEffect {
  constructor(label = "effect") {
    this.label = label;
    this.invocations = 0;
    this.pending = false;
    this.settled = false;
    this._resolve = null;
    this._reject = null;
  }

  /** Start the effect exactly once; returns its (still pending) promise. */
  start() {
    this.invocations += 1;
    this.pending = true;
    return new Promise((resolve, reject) => {
      this._resolve = (value) => {
        this.pending = false;
        this.settled = true;
        resolve(value);
      };
      this._reject = (error) => {
        this.pending = false;
        this.settled = true;
        reject(error);
      };
    });
  }

  /** Complete the fake effect successfully. */
  complete(value) {
    assert.equal(this.pending, true, "complete() called while effect not pending");
    this._resolve(value);
  }

  /** Fail the fake effect. */
  fail(error) {
    assert.equal(this.pending, true, "fail() called while effect not pending");
    this._reject(error);
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// ════════════════════════════════════════════════════════════
// Shape 1 — OperationGate (mirrors TdaiCore.ensureSchedulerStarted)
// ════════════════════════════════════════════════════════════

class OperationGate {
  /**
   * @param {() => Promise<unknown>} effect  the fake client operation
   * @param {{commit?: (value: unknown) => void, onFailure?: (err: unknown) => void}} [hooks]
   */
  constructor(effect, hooks = {}) {
    this._effect = effect;
    this._commit = hooks.commit ?? (() => {});
    this._onFailure = hooks.onFailure ?? (() => {});
    this.state = "idle"; // idle | pending | done | failed
    this.committed = 0; // number of times success state was written
    this.failures = 0; // number of times a failure was observed
    this.inFlight = undefined; // the promise sentinel (the success gate)
  }

  /** Mirrors `ensureSchedulerStarted()`: one shared in-flight promise per op. */
  run() {
    if (this.inFlight) return this.inFlight; // fast path: already started/starting
    this.state = "pending";
    this.inFlight = (async () => {
      const value = await this._effect();
      // ── commit point: only reachable AFTER the effect resolved ──
      this.state = "done";
      this.committed += 1;
      this._commit(value);
      return value;
    })();

    // Mirrors `.catch(() => { this.schedulerStartPromise = undefined; })`:
    // a rejected start sequence clears the gate so a retry is possible AND the
    // failure is recorded; on success the resolved promise is kept as sentinel.
    this.inFlight.catch((err) => {
      this.state = "failed";
      this.failures += 1;
      this.inFlight = undefined;
      this._onFailure(err);
    });

    return this.inFlight;
  }
}

// ════════════════════════════════════════════════════════════
// Shape 2 — CoalescingFakeClient (mirrors CachedCredentialProvider)
// ════════════════════════════════════════════════════════════

class CoalescingFakeClient {
  /**
   * @param {() => Promise<unknown>} fetcher the fake client effect
   * @param {{logger?: {warn?: (m: string) => void}, record?: (e: string) => void}} [opts]
   */
  constructor(fetcher, opts = {}) {
    this._fetcher = fetcher;
    this._logger = opts.logger ?? {};
    this._record = opts.record ?? (() => {});
    // Mirrors `CachedCredentialProvider.isExpired()`: a cached success is only
    // re-used while it is still fresh.
    this._isExpired = opts.isExpired ?? (() => false);
    this.cached = null; // committed success state
    this.commitCount = 0;
    this.fetchPromise = null; // in-flight effect promise
  }

  async get() {
    if (this.cached !== null && !this._isExpired()) {
      this._record("cache:hit");
      return this.cached;
    }
    if (!this.fetchPromise) {
      this._record("effect:start");
      this.fetchPromise = this._refresh();
    } else {
      this._record("effect:coalesced");
    }
    try {
      return await this.fetchPromise;
    } finally {
      this.fetchPromise = null;
    }
  }

  async _refresh() {
    try {
      const value = await this._fetcher();
      // ── commit point: only reachable AFTER `await this._fetcher()` resolved ──
      this.cached = value;
      this.commitCount += 1;
      this._record("commit");
      return value;
    } catch (err) {
      if (this.cached !== null) {
        this._logger.warn?.(`stale cache fallback: ${err}`);
        this._record("stale:fallback");
        return this.cached;
      }
      this._record("failure:observable");
      throw err; // failure is NOT swallowed
    }
  }
}

// ════════════════════════════════════════════════════════════
// Cases
// ════════════════════════════════════════════════════════════

await testCase("no_success_committed_while_effect_pending", async ({ events, record }) => {
  const effect = new FakeEffect();
  const gate = new OperationGate(
    () => {
      record("effect:start");
      return effect.start();
    },
    { commit: () => record("commit") },
  );

  const p = gate.run();
  await flush();

  // While the fake effect is still pending:
  assert.equal(effect.pending, true, "fake effect should still be pending");
  assert.equal(gate.state, "pending", `state must be pending, got ${gate.state}`);
  assert.equal(gate.committed, 0, "no success state may be committed yet");
  assert.deepEqual(events, ["effect:start"], "only the effect may have started");

  // Complete the fake effect, then observe the commit.
  effect.complete({ ok: true });
  const value = await p;
  assert.deepEqual(value, { ok: true });
  assert.equal(gate.committed, 1, "exactly one commit after the effect completes");
  assert.deepEqual(events, ["effect:start", "commit"], "commit must follow effect completion");
});

await testCase("commit_ordering_is_effect_then_success", async ({ events, record }) => {
  const effect = new FakeEffect();
  const gate = new OperationGate(
    () => {
      record("effect:start");
      return effect.start();
    },
    { commit: () => record("success-committed") },
  );

  const p = gate.run();
  await flush();
  assert.ok(!events.includes("success-committed"), "no success before effect resolves");

  effect.complete("v");
  await p;
  assert.deepEqual(events, ["effect:start", "success-committed"]);
  assert.ok(
    events.indexOf("success-committed") > events.indexOf("effect:start"),
    "success must be committed strictly after the fake effect started/completed",
  );
});

await testCase("concurrent_callers_share_one_effect_and_one_commit", async ({ events, record }) => {
  const effect = new FakeEffect();
  const client = new CoalescingFakeClient(
    () => {
      record("effect:invoked");
      return effect.start();
    },
    { record },
  );

  const calls = [client.get(), client.get(), client.get(), client.get(), client.get()];
  await flush();

  assert.equal(effect.invocations, 1, "the fake effect must be invoked exactly once");
  assert.equal(client.commitCount, 0, "nothing committed while the effect is pending");
  assert.equal(client.cached, null, "no cached success while the effect is pending");

  effect.complete("cred");
  const values = await Promise.all(calls);
  assert.deepEqual(values, ["cred", "cred", "cred", "cred", "cred"]);
  assert.equal(effect.invocations, 1, "coalescing must not re-invoke the effect");
  assert.equal(client.commitCount, 1, "exactly one commit for the coalesced batch");
  assert.equal(events.filter((e) => e === "commit").length, 1);
});

await testCase("failure_is_observable_and_never_committed", async ({ events, record }) => {
  const boom = new Error("fake client effect failed");
  const effect = new FakeEffect();
  const gate = new OperationGate(
    () => {
      record("effect:start");
      return effect.start();
    },
    { commit: () => record("commit") },
  );

  const p = gate.run();
  await flush();
  effect.fail(boom);

  await assert.rejects(p, (err) => err === boom, "the original failure must propagate to the caller");
  await flush();

  assert.equal(gate.committed, 0, "failure must not commit a success state");
  assert.equal(gate.state, "failed");
  assert.equal(gate.failures, 1, "the failure was observed exactly once");
  assert.ok(!events.includes("commit"), "no commit event on the failure path");
});

await testCase("coalescing_client_reraises_failure_when_no_stale_cache", async ({ events, record }) => {
  const boom = new Error("upstream 500");
  const client = new CoalescingFakeClient(
    async () => {
      record("effect:invoked");
      throw boom;
    },
    { record },
  );

  await assert.rejects(client.get(), (err) => err === boom);
  assert.equal(client.cached, null, "no success cached after failure");
  assert.equal(client.commitCount, 0);
  assert.ok(events.includes("failure:observable"));
  assert.ok(!events.includes("commit"));
  assert.equal(client.fetchPromise, null, "in-flight gate cleared so retry is possible");
});

await testCase("gate_clears_after_failure_so_retry_can_succeed", async ({ events, record }) => {
  let attempt = 0;
  const gate = new OperationGate(
    async () => {
      attempt += 1;
      record(`effect:attempt:${attempt}`);
      if (attempt === 1) throw new Error("first attempt fails");
      return "second-attempt-ok";
    },
    { commit: () => record("commit") },
  );

  await assert.rejects(gate.run(), /first attempt fails/);
  await flush();
  assert.equal(gate.committed, 0, "first failure committed nothing");
  assert.equal(gate.state, "failed");

  const value = await gate.run(); // retry after the gate was cleared
  assert.equal(value, "second-attempt-ok");
  assert.equal(gate.committed, 1, "only the successful retry commits");
  assert.deepEqual(events, ["effect:attempt:1", "effect:attempt:2", "commit"]);
});

await testCase("stale_cache_fallback_stays_observable", async ({ events, record }) => {
  let failNext = false;
  let expired = false;
  let warn = 0;
  const client = new CoalescingFakeClient(
    async () => {
      record("effect:invoked");
      if (failNext) throw new Error("refresh failed");
      return "fresh";
    },
    { record, logger: { warn: () => warn++ }, isExpired: () => expired },
  );

  assert.equal(await client.get(), "fresh");
  assert.equal(client.commitCount, 1);

  // Force the committed cache to look expired so the effect is re-invoked and
  // fails; the previously committed success is then served as a stale fallback.
  expired = true;
  failNext = true;
  const value = await client.get(); // stale fallback path
  assert.equal(value, "fresh", "stale cache is served, not a false success");
  assert.equal(warn, 1, "the failure was surfaced through the logger");
  assert.ok(events.includes("stale:fallback"));
  assert.equal(client.commitCount, 1, "stale fallback does not re-commit");
});

// ════════════════════════════════════════════════════════════
// Report
// ════════════════════════════════════════════════════════════

const failed = results.filter((r) => !r.pass);
console.log(
  JSON.stringify(
    {
      task: "T14",
      repository: "tdam",
      contract: "fake client operation: commit-after-effect, observable failure",
      cases: results,
      summary: { total: results.length, passed: results.length - failed.length, failed: failed.length },
    },
    null,
    2,
  ),
);

if (failed.length > 0) {
  console.error(`\nFAILED: ${failed.length}/${results.length}`);
  process.exit(1);
}
console.log(`\nOK: ${results.length}/${results.length} contract cases passed`);
