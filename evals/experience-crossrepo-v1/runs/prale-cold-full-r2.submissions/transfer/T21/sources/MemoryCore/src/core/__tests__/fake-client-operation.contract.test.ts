/**
 * T21 — fake client operation contract test (MemoryCore).
 *
 * Contract under test (normalized operation result):
 *   A MemoryCore operation that publishes shared state (a "commit") must obey
 *   the commit-after-effect ordering already used by the core facade:
 *     1. no success state is committed while the underlying client effect is
 *        still in flight — `status === "pending"` and `committed` stays empty;
 *     2. the success record is committed only after the effect resolves;
 *     3. when the effect rejects, the failure stays observable (the returned
 *        promise rejects and `failure` is recorded) and no success is committed;
 *     4. a failure is recoverable: the same operation can be retried, and no
 *        stale success from an earlier attempt is leaked.
 *
 * The fake client replaces the real external effects of MemoryCore (COS write /
 * meta_assets registration / pipeline call) with a deferred promise that only
 * settles when the test says so. That deferred control is what lets the test
 * observe the intermediate state between "operation started" and "effect done" —
 * the window in which an optimistic implementation would wrongly commit.
 *
 * Repository grounding (see `.prale-eval/contract-deliverable.md`):
 *   - `src/core/index.ts:25` re-exports `TdaiCore`, the host-neutral facade;
 *     its async methods (`handleTurnCommitted`) return only after the effect
 *     completes, so a resolved promise is the caller-visible success signal.
 *   - `src/core/index.ts:50-61` re-exports the storage seam
 *     (`StorageAdapter`, `createStorageBackend`, `LocalStorageBackend`), i.e. the
 *     repository already treats backends as injectable — a fake backend/client
 *     needs no network or cloud credentials.
 *   - `src/core/tdai-core.ts:86-91` (`SkillAssetHooks`) fixes the contract
 *     "onSkillCreated: v1 awaits it first; throwing = create failure".
 *   - `src/core/skill/skill-versioning.ts:117-205` (`createNewSkill`) awaits
 *     `onSkillCreated` (line 174), rolls back and rethrows on failure (line 198),
 *     and reaches `onSkillVdbChanged?.(1); return row;` (lines 202-204) only
 *     after every effect succeeded.
 *
 * Runner: Node's built-in test runner (no third-party dependency), because the
 * workspace ships without `node_modules` and vitest cannot be installed here.
 *
 *   node --test MemoryCore/src/core/__tests__/fake-client-operation.contract.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";

// ════════════════════════════════════════════════════════════════
// Normalized operation result (observable state of a client operation)
// ════════════════════════════════════════════════════════════════

export type OperationStatus = "idle" | "pending" | "succeeded" | "failed";

/** A committed success record — the only thing a caller may treat as "done". */
export interface CommittedRecord {
  effectId: string;
  payload: string;
}

/** Observable failure, kept on the state so failures never disappear silently. */
export interface ObservableFailure {
  message: string;
  code?: string;
}

export interface OperationState {
  status: OperationStatus;
  /** Success state. Must stay empty until the effect has completed. */
  committed: CommittedRecord[];
  /** Last observable failure, or null. */
  failure: ObservableFailure | null;
  /** Ordered trace used to prove commit ordering. */
  events: string[];
}

export function createOperationState(): OperationState {
  return { status: "idle", committed: [], failure: null, events: [] };
}

// ════════════════════════════════════════════════════════════════
// Fake client — the deferred effect
// ════════════════════════════════════════════════════════════════

export interface EffectReceipt {
  effectId: string;
  payload: string;
}

interface EffectCall {
  payload: string;
  state: "pending" | "resolved" | "rejected";
}

type Resolvers = {
  resolve: (receipt: EffectReceipt) => void;
  reject: (error: unknown) => void;
};

/**
 * Fake MemoryCore client. `performEffect` never settles on its own: the test
 * decides when the effect completes (`completeEffect`) or fails (`failEffect`).
 */
export class FakeMemoryCoreClient {
  readonly calls: EffectCall[] = [];
  private resolvers: Resolvers | null = null;

  performEffect(payload: string): Promise<EffectReceipt> {
    const call: EffectCall = { payload, state: "pending" };
    this.calls.push(call);
    const promise = new Promise<EffectReceipt>((resolve, reject) => {
      this.resolvers = { resolve, reject };
    });
    return promise;
  }

  /** Effects started but not yet settled — must be 0 before any commit. */
  get inFlightCount(): number {
    return this.calls.filter((c) => c.state === "pending").length;
  }

  completeEffect(effectId: string, payload: string): void {
    const call = this.lastPending();
    call.state = "resolved";
    const resolvers = this.takeResolvers();
    resolvers.resolve({ effectId, payload });
  }

  failEffect(error: unknown): void {
    const call = this.lastPending();
    call.state = "rejected";
    const resolvers = this.takeResolvers();
    resolvers.reject(error);
  }

  private lastPending(): EffectCall {
    const call = this.calls[this.calls.length - 1];
    if (!call || call.state !== "pending") {
      throw new Error("fake client: no pending effect to settle");
    }
    return call;
  }

  private takeResolvers(): Resolvers {
    const resolvers = this.resolvers;
    if (!resolvers) throw new Error("fake client: no settled resolvers");
    this.resolvers = null;
    return resolvers;
  }
}

// ════════════════════════════════════════════════════════════════
// Subjects under test
// ════════════════════════════════════════════════════════════════

/**
 * Commit-after-effect implementation — the contract shape of MemoryCore's
 * `TdaiCore.handleTurnCommitted` / `SkillVersioning.createNewSkill`: await the
 * effect, publish success afterwards, and let failures escape to the caller.
 */
export async function runCommitAfterEffect(
  client: FakeMemoryCoreClient,
  state: OperationState,
  payload: string,
): Promise<EffectReceipt> {
  state.status = "pending";
  state.events.push("op:start");

  let receipt: EffectReceipt;
  try {
    receipt = await client.performEffect(payload);
  } catch (error) {
    // The effect failed: record an observable failure and never commit success.
    state.status = "failed";
    state.failure = toObservableFailure(error);
    state.events.push("effect:failed");
    throw error;
  }

  state.events.push("effect:completed");
  // Success is committed only now — after the fake effect completed.
  state.committed.push({ effectId: receipt.effectId, payload: receipt.payload });
  state.failure = null;
  state.status = "succeeded";
  state.events.push("commit:success");
  return receipt;
}

/**
 * Control subject: optimistic/eager commit, i.e. the anti-pattern. It exists so
 * the test can show that its own assertions actually discriminate — the same
 * probes that pass for `runCommitAfterEffect` fail for this implementation.
 */
export async function runEagerCommit(
  client: FakeMemoryCoreClient,
  state: OperationState,
  payload: string,
): Promise<EffectReceipt> {
  state.status = "pending";
  state.events.push("op:start");
  state.committed.push({ effectId: "optimistic", payload });
  state.status = "succeeded";
  state.events.push("commit:eager");
  const receipt = await client.performEffect(payload);
  state.events.push("effect:completed");
  return receipt;
}

function toObservableFailure(error: unknown): ObservableFailure {
  const err = error as { message?: string; code?: string };
  return {
    message: err?.message ?? String(error),
    code: err?.code,
  };
}

// ════════════════════════════════════════════════════════════════
// Test helpers
// ════════════════════════════════════════════════════════════════

/** Let queued microtasks and timers run, so a premature commit would surface. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
}

interface Settlement { settled: boolean }

/** Track settlement without swallowing the rejection the test asserts on. */
function track<T>(promise: Promise<T>): Settlement {
  const settlement: Settlement = { settled: false };
  promise.then(
    () => { settlement.settled = true; },
    () => { settlement.settled = true; },
  );
  return settlement;
}

function indexOfEvent(state: OperationState, event: string): number {
  return state.events.indexOf(event);
}

// ════════════════════════════════════════════════════════════════
// Tests
// ════════════════════════════════════════════════════════════════

test("no success state is committed while the fake effect is still in flight", async () => {
  const client = new FakeMemoryCoreClient();
  const state = createOperationState();

  const operation = runCommitAfterEffect(client, state, "turn-1");
  const settlement = track(operation);

  // The fake effect is deliberately left unresolved: give the event loop real
  // time (not just one microtask) so an eager commit would have happened.
  await flush();

  assert.equal(client.inFlightCount, 1, "fake effect should still be in flight");
  assert.equal(state.status, "pending", "operation must still be pending");
  assert.deepEqual(state.committed, [], "no success record may be committed yet");
  assert.equal(state.failure, null, "no failure yet");
  assert.equal(settlement.settled, false, "operation promise must not have settled");
  assert.equal(indexOfEvent(state, "commit:success"), -1, "no commit event yet");

  // Now let the effect complete: only then is success observable.
  client.completeEffect("effect-1", "turn-1");
  const receipt = await operation;

  assert.equal(receipt.effectId, "effect-1");
  assert.equal(state.status, "succeeded");
  assert.equal(state.committed.length, 1);
  assert.ok(settlement.settled, "operation promise settles after the effect");
});

test("success is committed after (never before) the effect completes", async () => {
  const client = new FakeMemoryCoreClient();
  const state = createOperationState();

  const operation = runCommitAfterEffect(client, state, "turn-2");
  await flush();
  assert.equal(state.committed.length, 0);

  client.completeEffect("effect-2", "turn-2");
  await operation;

  const effectIndex = indexOfEvent(state, "effect:completed");
  const commitIndex = indexOfEvent(state, "commit:success");
  assert.ok(effectIndex >= 0, "effect completion must be recorded");
  assert.ok(commitIndex > effectIndex, "commit must follow effect completion");
  assert.deepEqual(state.committed, [{ effectId: "effect-2", payload: "turn-2" }]);
});

test("effect failure is observable and never becomes a committed success", async () => {
  const client = new FakeMemoryCoreClient();
  const state = createOperationState();

  const failure = Object.assign(new Error("cos put failed"), { code: "E_COS" });
  const operation = runCommitAfterEffect(client, state, "turn-3");
  const settlement = track(operation);

  await flush();
  assert.equal(state.status, "pending");
  assert.deepEqual(state.committed, []);

  client.failEffect(failure);

  await assert.rejects(operation, /cos put failed/);

  assert.equal(state.status, "failed");
  assert.equal(state.committed.length, 0, "a failed effect must not commit success");
  assert.deepEqual(state.failure, { message: "cos put failed", code: "E_COS" });
  assert.equal(indexOfEvent(state, "commit:success"), -1);
  assert.ok(indexOfEvent(state, "effect:failed") >= 0);
  assert.ok(settlement.settled, "failure must reach the returned promise, not be swallowed");
});

test("an observable failure can be retried without leaking stale success", async () => {
  const client = new FakeMemoryCoreClient();
  const state = createOperationState();

  const first = runCommitAfterEffect(client, state, "turn-4");
  await flush();
  client.failEffect(new Error("transient network error"));
  await assert.rejects(first, /transient network error/);

  const observedAfterFailure = state.failure;
  assert.equal(state.status, "failed");
  assert.equal(state.committed.length, 0);
  assert.ok(observedAfterFailure !== null, "failure stays observable on the state");

  const second = runCommitAfterEffect(client, state, "turn-4");
  await flush();
  assert.equal(state.committed.length, 0, "retry does not inherit a stale success");
  client.completeEffect("effect-4", "turn-4");
  await second;

  assert.equal(state.status, "succeeded");
  assert.equal(state.committed.length, 1);
  assert.deepEqual(state.committed, [{ effectId: "effect-4", payload: "turn-4" }]);
  assert.equal(client.calls.length, 2, "the fake effect was attempted twice");
});

test("control: an eager-commit implementation fails the same assertions", async () => {
  const contractClient = new FakeMemoryCoreClient();
  const contractState = createOperationState();
  const eagerClient = new FakeMemoryCoreClient();
  const eagerState = createOperationState();

  const contractOp = runCommitAfterEffect(contractClient, contractState, "turn-5");
  const eagerOp = runEagerCommit(eagerClient, eagerState, "turn-5");

  await flush();

  // Same "while the effect is in flight" probes, opposite outcomes:
  assert.equal(contractState.committed.length, 0, "contract holds: nothing committed yet");
  assert.equal(contractState.status, "pending");
  assert.notEqual(eagerState.committed.length, 0, "eager control commits prematurely");
  assert.equal(eagerState.status, "succeeded", "eager control publishes false success");
  assert.equal(eagerClient.inFlightCount, 1, "eager control's effect is still in flight");

  // Settle both so the run finishes without dangling work.
  contractClient.completeEffect("effect-5", "turn-5");
  eagerClient.completeEffect("effect-5", "turn-5");
  await contractOp;
  await eagerOp;

  assert.equal(eagerState.events.indexOf("commit:eager") < eagerState.events.indexOf("effect:completed"), true);
});
