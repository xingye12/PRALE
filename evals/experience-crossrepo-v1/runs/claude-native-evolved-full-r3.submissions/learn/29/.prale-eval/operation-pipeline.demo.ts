/**
 * Executable model of pi's durable operation pipeline:
 *
 *     durable intent  ->  effect (pending)  ->  settlement
 *
 * with explicit handling for a *failed effect*.
 *
 * Grounded in the public harness surface of packages/agent:
 *   - intent:     `OperationMeta.intent`                       (harness/session/types.ts)
 *   - effect:     `ToolCall` "effect_pending" + the
 *                 `*.effect_pending` operation leaves         (harness/session/types.ts)
 *   - retry:      `RetryWait` + `assistant.retry_wait` leaf    (harness/session/types.ts)
 *   - settlement: `OperationResultRecord` built by
 *                 `operationResultRecord()`                   (harness/runtime/drive/terminal.ts)
 *
 * The demo reuses the repository's real `Result` union and tagged errors at
 * runtime, and its real operation types type-only (erased by Node's type
 * stripping), so it exercises the repo's own contract without a build step.
 *
 * Run: node .prale-eval/operation-pipeline.demo.ts
 */
import { LaneBusy, Result } from "../packages/agent/src/harness/result.ts";
import type {
	OperationError,
	OperationMeta,
	OperationResultRecord,
	TerminalStatus,
} from "../packages/agent/src/harness/session/types.ts";

type Intent = OperationMeta["intent"];
type Kind = Intent["kind"];

/** Non-retryable settlement invariant, mirroring `SessionInvariantError` in drive/terminal.ts. */
class SettlementInvariantError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SettlementInvariantError";
	}
}

/** 1. INTENT ------------------------------------------------------------------ */

/** A durable intent: classified and identified before any side effect runs. */
function makeIntent(kind: Kind, operationId: string, detail?: string): OperationMeta {
	const intent: Intent =
		kind === "run"
			? { kind, promptEntryIds: detail === undefined ? [] : [detail] }
			: kind === "compaction"
				? { kind, customInstructions: detail }
				: { kind, targetId: detail ?? null, summarize: true };
	return { operationId, lane: "main", sourceTipId: null, startedAt: 1_000, intent };
}

/** 2. EFFECT ------------------------------------------------------------------ */

interface EffectResult {
	ok: boolean;
	error?: OperationError;
	/** Whether the failure may be retried (assistant/summary retry_wait path). */
	retryable?: boolean;
}

interface EffectPlan {
	count: number;
	/** Outcome of the n-th dispatched effect attempt (1-based). */
	attempt(n: number): EffectResult;
}

interface EffectAttempt {
	attempt: number;
	state: "effect_pending" | "retry_wait" | "outcome_ready";
	error?: OperationError;
	/** Durable retry bookkeeping, mirroring `RetryWait`. */
	retryWait?: { nextAttempt: number; notBefore: number; errorMessage: string };
}

/** 3. SETTLEMENT -------------------------------------------------------------- */

/**
 * Build the immutable terminal record. Enforces the same invariant as the
 * repository: only a `failed` settlement may carry an error, and `failed`
 * must carry one.
 */
function settle(
	meta: OperationMeta,
	status: TerminalStatus,
	tipId: string | null,
	error?: OperationError,
): OperationResultRecord {
	if ((status === "failed") !== (error !== undefined)) {
		throw new SettlementInvariantError("Only a failed operation result may carry an error");
	}
	return {
		operationId: meta.operationId,
		kind: meta.intent.kind,
		status,
		...(error === undefined ? {} : { error }),
		fromTipId: meta.sourceTipId,
		tipId,
		startedAt: meta.startedAt,
		endedAt: 2_000,
	};
}

/** Strict-JSON view published to remote transcript consumers. */
function normalize(record: OperationResultRecord): string {
	return JSON.stringify(record);
}

/** Drive one durable intent to settlement through a plan of effects. */
function runOperation(
	meta: OperationMeta,
	plan: EffectPlan,
	options: { abort?: boolean; maxAttempts?: number } = {},
): { record: OperationResultRecord; journal: EffectAttempt[] } {
	const journal: EffectAttempt[] = [];
	const maxAttempts = options.maxAttempts ?? 3;

	if (options.abort === true) {
		return { record: settle(meta, "aborted", "tip-1"), journal };
	}

	for (let n = 1; n <= plan.count; n += 1) {
		journal.push({ attempt: n, state: "effect_pending" });
		const effect = plan.attempt(n);
		if (effect.ok) {
			journal.push({ attempt: n, state: "outcome_ready" });
			return { record: settle(meta, "completed", `tip-${n}`), journal };
		}

		const error = effect.error ?? { code: "effect_error", message: "effect failed" };
		const canRetry = effect.retryable === true && n < Math.min(plan.count, maxAttempts);
		if (canRetry) {
			// Durable retry leaf: survives a crash and resumes without replaying the effect.
			journal.push({
				attempt: n,
				state: "retry_wait",
				error,
				retryWait: { nextAttempt: n + 1, notBefore: 1_000 + n * 100, errorMessage: error.message },
			});
			continue;
		}

		// Terminal failed effect: settle with the error and no further attempt.
		journal.push({ attempt: n, state: "outcome_ready", error });
		return { record: settle(meta, "failed", null, error), journal };
	}

	throw new SettlementInvariantError("plan produced no settlement");
}

/** 4. DEMO -------------------------------------------------------------------- */

const results: unknown[] = [];

// (a) successful run: intent -> effect -> completed settlement
const okRun = runOperation(makeIntent("run", "op-ok", "entry-1"), {
	count: 1,
	attempt: () => ({ ok: true }),
});
results.push({ scenario: "success", record: okRun.record, journal: okRun.journal });

// (b) retryable failed effect: durable retry_wait leaf, then settlement
const retriedRun = runOperation(makeIntent("run", "op-retry", "entry-2"), {
	count: 3,
	attempt: (n) => (n < 3 ? { ok: false, retryable: true, error: { code: "rate_limited", message: "429" } } : { ok: true }),
});
results.push({ scenario: "retryable_failure", record: retriedRun.record, journal: retriedRun.journal });

// (c) terminal failed effect: settlement carries the OperationError
const failedRun = runOperation(makeIntent("compaction", "op-fail", "be terse"), {
	count: 1,
	attempt: () => ({ ok: false, error: { code: "provider_error", message: "upstream 500" } }),
});
results.push({ scenario: "failed_effect", record: failedRun.record, journal: failedRun.journal });

// (d) aborted before settlement: no error attached
const aborted = runOperation(makeIntent("navigation", "op-abort", "entry-0"), { count: 1, attempt: () => ({ ok: true }) }, { abort: true });
results.push({ scenario: "aborted", record: aborted.record, journal: aborted.journal });

for (const entry of results) {
	console.log(normalize((entry as { record: OperationResultRecord }).record));
}

// (e) durability guards reused from the repo itself
const busy = Result.err(
	new LaneBusy({ lane: "main", operationId: "op-ok", operationKind: "run", message: "lane busy" }),
);
if (!Result.isErr(busy) || !LaneBusy.is(busy.error)) {
	throw new Error("expected a LaneBusy admission rejection");
}
console.log("admission rejected before any effect:", busy.error._tag, busy.error.operationId);

// (f) invariant: a failed settlement must carry an error
let guarded = false;
try {
	settle(makeIntent("run", "op-guard"), "failed", null);
} catch (error) {
	guarded = error instanceof SettlementInvariantError;
}
if (!guarded) {
	throw new Error("failed settlement without error was not rejected");
}
console.log("failed settlement without error rejected by invariant: true");
console.log(`OK: ${results.length} settlements modeled, ${retriedRun.journal.filter((a) => a.state === "retry_wait").length} durable retry leaf(s)`);
