/**
 * Tiny local RPC/command adapter demo.
 *
 * It transfers two behaviors observed in `packages/agent/src/proxy.ts`:
 *
 * 1. Validate input before performing the effect. `streamProxy` checks
 *    `response.ok` (proxy.ts:174) and only starts consuming / dispatching
 *    stream events after that check passes; a rejected request never reaches
 *    the event-processing side effects.
 * 2. Report every failure through one stable error shape. `streamProxy` funnels
 *    HTTP failures, mid-stream EOF and thrown exceptions into the same
 *    `{ type: "error", reason, error }` event (proxy.ts:238, 251), and the
 *    `ProxyAssistantMessageEvent` union reserves exactly one `error` variant
 *    (proxy.ts:53-59).
 *
 * This file is self-contained (no imports, no dependencies) so it can run with
 * plain `node .prale-eval/rpc-adapter-demo.ts` under Node strip-only mode.
 */

// ---------------------------------------------------------------------------
// Stable error shape
// ---------------------------------------------------------------------------

/** The only set of failure codes the adapter can emit. */
type AdapterErrorCode = "invalid_envelope" | "unknown_command" | "invalid_params" | "command_failed";

/**
 * The single stable error shape. Every rejection and every failed command
 * returns this object, never a bare string or a raw thrown Error.
 */
interface AdapterError {
	type: "error";
	code: AdapterErrorCode;
	message: string;
	requestId: string | null;
}

interface AdapterOk {
	type: "ok";
	requestId: string;
	value: unknown;
}

type AdapterResult = AdapterOk | AdapterError;

// ---------------------------------------------------------------------------
// Command registry
// ---------------------------------------------------------------------------

type Params = Record<string, unknown>;

interface CommandDefinition {
	name: string;
	/** Returns a human-readable problem string, or null when params are valid. */
	validate: (params: Params) => string | null;
	/** The (here: fake) effect. Only runs after validation passes. */
	effect: (params: Params) => unknown;
}

/** Records performed effects so the demo can prove none ran for invalid input. */
const effects: string[] = [];

const commands: CommandDefinition[] = [
	{
		name: "add",
		validate: (params) => {
			if (typeof params.a !== "number" || typeof params.b !== "number") {
				return "add requires numeric 'a' and 'b'";
			}
			return null;
		},
		effect: (params) => {
			const a = params.a as number;
			const b = params.b as number;
			effects.push(`add(${a},${b})`);
			return a + b;
		},
	},
	{
		name: "reverse",
		validate: (params) => {
			if (typeof params.text !== "string") return "reverse requires string 'text'";
			return null;
		},
		effect: (params) => {
			const text = params.text as string;
			effects.push(`reverse(${text})`);
			return [...text].reverse().join("");
		},
	},
	{
		name: "boom",
		validate: () => null,
		effect: () => {
			effects.push("boom()");
			throw new Error("effect exploded");
		},
	},
];

const registry = new Map<string, CommandDefinition>(commands.map((command) => [command.name, command]));

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

function errorResult(code: AdapterErrorCode, message: string, requestId: string | null): AdapterError {
	return { type: "error", code, message, requestId };
}

/** Envelope validation. Runs before any command lookup or effect. */
function validateEnvelope(request: unknown): string | null {
	if (typeof request !== "object" || request === null) return "request must be an object";
	const candidate = request as Partial<Record<string, unknown>>;
	if (typeof candidate.requestId !== "string" || candidate.requestId.length === 0) {
		return "requestId must be a non-empty string";
	}
	if (typeof candidate.command !== "string" || candidate.command.length === 0) {
		return "command must be a non-empty string";
	}
	if (candidate.params !== undefined && (typeof candidate.params !== "object" || candidate.params === null)) {
		return "params must be an object when present";
	}
	return null;
}

/**
 * Single entry point for the local adapter.
 *
 * Order matters: envelope -> command lookup -> parameter validation -> effect.
 * Nothing past validation runs for a rejected request, so an invalid input can
 * never trigger the fake effect.
 */
function dispatch(request: unknown): AdapterResult {
	const envelopeProblem = validateEnvelope(request);
	if (envelopeProblem) {
		const requestId =
			typeof request === "object" && request !== null && typeof (request as Params).requestId === "string"
				? ((request as Params).requestId as string)
				: null;
		return errorResult("invalid_envelope", envelopeProblem, requestId);
	}

	const envelope = request as { requestId: string; command: string; params?: Params };

	const command = registry.get(envelope.command);
	if (!command) {
		return errorResult("unknown_command", `Unknown command: ${envelope.command}`, envelope.requestId);
	}

	const params = envelope.params ?? {};
	const paramProblem = command.validate(params);
	if (paramProblem) {
		return errorResult("invalid_params", paramProblem, envelope.requestId);
	}

	// The effect only runs for a fully validated request.
	try {
		return { type: "ok", requestId: envelope.requestId, value: command.effect(params) };
	} catch (error) {
		return errorResult(
			"command_failed",
			error instanceof Error ? error.message : String(error),
			envelope.requestId,
		);
	}
}

// ---------------------------------------------------------------------------
// Demo runner
// ---------------------------------------------------------------------------

let failures = 0;

function check(label: string, condition: boolean, detail?: string): void {
	if (condition) {
		console.log(`  PASS  ${label}`);
		return;
	}
	failures += 1;
	console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ""}`);
}

const ERROR_KEYS = ["type", "code", "message", "requestId"].sort();
const ERROR_CODES = new Set<AdapterErrorCode>([
	"invalid_envelope",
	"unknown_command",
	"invalid_params",
	"command_failed",
]);

function isAdapterError(result: AdapterResult): result is AdapterError {
	return result.type === "error";
}

function hasStableErrorShape(result: AdapterResult): boolean {
	if (!isAdapterError(result)) return false;
	const keys = Object.keys(result).sort();
	return (
		keys.join(",") === ERROR_KEYS.join(",") &&
		result.type === "error" &&
		ERROR_CODES.has(result.code) &&
		typeof result.message === "string"
	);
}

interface Scenario {
	label: string;
	request: unknown;
	expect: "ok" | "error";
	expectedCode?: AdapterErrorCode;
}

const scenarios: Scenario[] = [
	{
		label: "valid add performs the effect",
		request: { requestId: "r1", command: "add", params: { a: 2, b: 3 } },
		expect: "ok",
	},
	{
		label: "non-numeric add is rejected before the effect",
		request: { requestId: "r2", command: "add", params: { a: "2", b: 3 } },
		expect: "error",
		expectedCode: "invalid_params",
	},
	{
		label: "missing required param is rejected before the effect",
		request: { requestId: "r3", command: "reverse", params: {} },
		expect: "error",
		expectedCode: "invalid_params",
	},
	{
		label: "unknown command is rejected",
		request: { requestId: "r4", command: "nope", params: {} },
		expect: "error",
		expectedCode: "unknown_command",
	},
	{
		label: "missing requestId is rejected",
		request: { command: "add", params: { a: 1, b: 1 } },
		expect: "error",
		expectedCode: "invalid_envelope",
	},
	{
		label: "non-object request is rejected",
		request: "not-a-request",
		expect: "error",
		expectedCode: "invalid_envelope",
	},
	{
		label: "thrown effect failure uses the same error shape",
		request: { requestId: "r7", command: "boom", params: {} },
		expect: "error",
		expectedCode: "command_failed",
	},
];

console.log("Local RPC/command adapter demo");
console.log("-------------------------------");

const results: AdapterResult[] = [];

for (const scenario of scenarios) {
	const effectCountBefore = effects.length;
	const result = dispatch(scenario.request);
	results.push(result);
	console.log(`${scenario.label}:`);
	console.log(`  -> ${JSON.stringify(result)}`);

	check(`${scenario.label}: result type is ${scenario.expect}`, result.type === scenario.expect);

	if (scenario.expect === "error") {
		check(`${scenario.label}: uses the one stable error shape`, hasStableErrorShape(result));
		if (scenario.expectedCode) {
			check(
				`${scenario.label}: code is ${scenario.expectedCode}`,
				isAdapterError(result) && result.code === scenario.expectedCode,
			);
		}
		// Rejections happen before the effect. A command that was dispatched and
		// then threw (`command_failed`) is not a rejection, so its effect did run.
		if (scenario.expectedCode !== "command_failed") {
			check(
				`${scenario.label}: effect not performed`,
				effects.length === effectCountBefore,
				`effects=${JSON.stringify(effects)}`,
			);
		}
	}
}

console.log("");
console.log("After all scenarios:");
check("only the valid add and the boom attempt reached the effect layer", effects.length === 2, `effects=${JSON.stringify(effects)}`);

// Every error produced by the adapter must share the same key set and code domain.
const allErrors = results.filter(isAdapterError);
check(
	"every error result shares one shape",
	allErrors.every((error) => [...ERROR_KEYS].sort().join(",") === Object.keys(error).sort().join(",")),
);

console.log("");
if (failures > 0) {
	console.log(`FAILED: ${failures} check(s) failed`);
	process.exitCode = 1;
} else {
	console.log("All demo checks passed");
}
