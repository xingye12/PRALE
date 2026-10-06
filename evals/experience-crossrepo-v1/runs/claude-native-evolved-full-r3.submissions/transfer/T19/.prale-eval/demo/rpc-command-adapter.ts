/**
 * Tiny local RPC/command adapter demo.
 *
 * It transfers two behaviors from `packages/agent/src/proxy.ts`:
 *
 * 1. Reject invalid input before the effect runs.
 *    `processProxyEvent` validates each incoming proxy event against the
 *    message built so far and throws before applying it
 *    ("Received text_delta for non-text content") instead of mutating state.
 *
 * 2. One stable error shape.
 *    `streamProxy` funnels every failure path (bad HTTP status, parse failure,
 *    aborted request, dropped stream) into the same normalized error event
 *    `{ type: "error", reason, error }` with `stopReason`/`errorMessage` set.
 *
 * The adapter below does the same at a command boundary: input is parsed and
 * validated first, the fake effect is only reached for validated input, and
 * every rejection crosses the boundary as one `AdapterResult` error shape.
 *
 * Run: node .prale-eval/demo/rpc-command-adapter.ts
 */

type Command =
	| { type: "set"; key: string; value: number }
	| { type: "get"; key: string }
	| { type: "drop"; key: string }
	| { type: "reset" };

type ErrorCode = "bad_request" | "unsupported_command" | "not_found" | "internal";

/** The single stable rejection shape returned across the adapter boundary. */
interface AdapterError {
	code: ErrorCode;
	/** Stable, human-readable text. Never carries a stack trace. */
	message: string;
	/** Command type that caused the rejection, or "unknown" if it could not be read. */
	command: string;
}

type AdapterResult<T> = { ok: true; value: T } | { ok: false; error: AdapterError };

/** Internal control-flow error. Normalized at the boundary, never leaks out. */
class CommandRejected extends Error {
	readonly code: ErrorCode;

	constructor(code: ErrorCode, message: string) {
		super(message);
		this.name = "CommandRejected";
		this.code = code;
	}
}

interface AdapterState {
	values: Map<string, number>;
	/** The observable fake effect. Must stay empty for rejected input. */
	effects: string[];
}

/**
 * Pure validation. Reads the raw input and either returns a well-formed
 * `Command` or throws `CommandRejected`. It never touches `AdapterState`,
 * so a rejection here cannot have run the effect.
 */
function validate(raw: unknown): Command {
	if (typeof raw !== "object" || raw === null || typeof (raw as { type?: unknown }).type !== "string") {
		throw new CommandRejected("bad_request", "Command must be an object with a string 'type'");
	}
	const candidate = raw as { type: string; [key: string]: unknown };
	switch (candidate.type) {
		case "set": {
			if (typeof candidate.key !== "string" || candidate.key.length === 0) {
				throw new CommandRejected("bad_request", "set requires a non-empty string 'key'");
			}
			if (typeof candidate.value !== "number" || !Number.isFinite(candidate.value)) {
				throw new CommandRejected("bad_request", "set requires a finite numeric 'value'");
			}
			return { type: "set", key: candidate.key, value: candidate.value };
		}
		case "get":
		case "drop": {
			if (typeof candidate.key !== "string" || candidate.key.length === 0) {
				throw new CommandRejected("bad_request", `${candidate.type} requires a non-empty string 'key'`);
			}
			return { type: candidate.type, key: candidate.key };
		}
		case "reset":
			return { type: "reset" };
		default:
			throw new CommandRejected("unsupported_command", `Unsupported command type: ${candidate.type}`);
	}
}

/** Runs the effect for an already-validated command. */
function applyCommand(state: AdapterState, command: Command): string {
	switch (command.type) {
		case "set": {
			state.effects.push(`set ${command.key}=${command.value}`);
			state.values.set(command.key, command.value);
			return `set ${command.key}`;
		}
		case "get": {
			const value = state.values.get(command.key);
			if (value === undefined) {
				throw new CommandRejected("not_found", `No value stored for key: ${command.key}`);
			}
			state.effects.push(`get ${command.key}`);
			return `${command.key}=${value}`;
		}
		case "drop": {
			if (!state.values.has(command.key)) {
				throw new CommandRejected("not_found", `No value stored for key: ${command.key}`);
			}
			state.effects.push(`drop ${command.key}`);
			state.values.delete(command.key);
			return `dropped ${command.key}`;
		}
		case "reset": {
			state.effects.push(`reset ${state.values.size}`);
			state.values.clear();
			return "reset";
		}
	}
}

function readCommandType(raw: unknown): string {
	if (typeof raw === "object" && raw !== null && typeof (raw as { type?: unknown }).type === "string") {
		return (raw as { type: string }).type;
	}
	return "unknown";
}

/** The one place any failure becomes an `AdapterError`, mirroring `streamProxy`'s catch. */
function toAdapterError(error: unknown, raw: unknown): AdapterError {
	const command = readCommandType(raw);
	if (error instanceof CommandRejected) {
		return { code: error.code, message: error.message, command };
	}
	const message = error instanceof Error ? error.message : String(error);
	return { code: "internal", message, command };
}

/**
 * Adapter boundary. Validate first, apply second, normalize every failure last.
 * The returned error object always has the exact same keys.
 */
function handleCommand(state: AdapterState, raw: unknown): AdapterResult<string> {
	try {
		const command = validate(raw);
		return { ok: true, value: applyCommand(state, command) };
	} catch (error) {
		return { ok: false, error: toAdapterError(error, raw) };
	}
}

function newState(): AdapterState {
	return { values: new Map(), effects: [] };
}

let failures = 0;

function check(label: string, condition: boolean, detail: string): void {
	if (condition) {
		console.log(`PASS  ${label}  ${detail}`);
		return;
	}
	failures += 1;
	console.log(`FAIL  ${label}  ${detail}`);
}

function main(): void {
	const state = newState();

	// 1. Valid input reaches the effect.
	const set = handleCommand(state, { type: "set", key: "a", value: 1 });
	check("valid set", set.ok === true && state.values.get("a") === 1, `effects=${state.effects.length}`);

	// 2. Invalid input is rejected before the effect: no new effect, state untouched.
	const effectsBefore = state.effects.length;
	const badValue = handleCommand(state, { type: "set", key: "a", value: "1" });
	check(
		"reject before effect (bad value)",
		badValue.ok === false &&
			badValue.error.code === "bad_request" &&
			state.effects.length === effectsBefore &&
			state.values.get("a") === 1,
		`code=${badValue.ok === false ? badValue.error.code : "ok"} effects=${state.effects.length}`,
	);

	// 3. Unknown command type is rejected, still before the effect.
	const unsupported = handleCommand(state, { type: "text_delta", key: "a" });
	check(
		"reject before effect (unknown type)",
		unsupported.ok === false &&
			unsupported.error.code === "unsupported_command" &&
			state.effects.length === effectsBefore,
		`code=${unsupported.ok === false ? unsupported.error.code : "ok"}`,
	);

	// 4. Non-object input is rejected with the same shape.
	const notObject = handleCommand(state, 42);
	check(
		"reject before effect (non-object)",
		notObject.ok === false &&
			notObject.error.code === "bad_request" &&
			notObject.error.command === "unknown" &&
			state.effects.length === effectsBefore,
		`code=${notObject.ok === false ? notObject.error.code : "ok"}`,
	);

	// 5. Runtime misses share the exact same error shape.
	const missing = handleCommand(state, { type: "get", key: "ghost" });
	check(
		"runtime miss same shape",
		missing.ok === false && missing.error.code === "not_found",
		`code=${missing.ok === false ? missing.error.code : "ok"}`,
	);

	// 6. Every rejection carries exactly the keys of the one stable shape.
	const rejections = [badValue, unsupported, notObject, missing];
	const keysStable = rejections.every(
		(result) =>
			result.ok === false &&
			Object.keys(result).sort().join(",") === "error,ok" &&
			Object.keys(result.error).sort().join(",") === "code,command,message",
	);
	check("one stable error shape", keysStable, `${rejections.length} rejections normalized`);

	// 7. A forced internal failure is normalized too, not leaked as a throw.
	const originalApply = state.values.set;
	let leaked = false;
	try {
		(state.values as unknown as { set: unknown }).set = () => {
			throw new Error("backend exploded");
		};
		const internal = handleCommand(state, { type: "set", key: "b", value: 2 });
		check(
			"internal failure normalized",
			internal.ok === false && internal.error.code === "internal",
			`code=${internal.ok === false ? internal.error.code : "ok"}`,
		);
	} catch {
		leaked = true;
	} finally {
		(state.values as unknown as { set: unknown }).set = originalApply;
	}
	check("no throw escapes boundary", leaked === false, `leaked=${leaked}`);

	console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
	if (failures > 0) process.exitCode = 1;
}

main();
