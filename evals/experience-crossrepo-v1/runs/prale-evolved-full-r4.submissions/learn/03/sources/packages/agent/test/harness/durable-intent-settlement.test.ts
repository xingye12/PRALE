import type { JsonObject } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import { createGate, type Gate } from "../../src/harness/execution/effect-gate.ts";
import {
	applyBeforeToolDecision,
	type ClearedToolCall,
	executeToolCall,
	prepareToolCall,
} from "../../src/harness/execution/tools.ts";
import type { AgentHarnessTool } from "../../src/harness/types.ts";
import type { AgentToolCall, AgentToolResult } from "../../src/types.ts";

/**
 * Contract: an operation's effect cannot be observed before its durable intent has settled.
 *
 * The durable harness publishes an `effect_pending` intent (the cleared call plus its
 * arguments) to the session and only then crosses the external effect boundary
 * (runtime/drive/tools.ts: startToolInvocation awaits publishToolIntent before
 * performToolInvocation). These tests pin that ordering at the primitive boundary used by
 * that procedure: the effect handed to the effect gate is never entered while settlement is
 * outstanding, and a failed settlement leaves the external effect untouched.
 */

const parameters = Type.Object({ value: Type.String() });

type EchoTool = AgentHarnessTool<undefined, typeof parameters, { value: string }>;

function call(arguments_: JsonObject = { value: "input" }): AgentToolCall {
	return { type: "toolCall", id: "call-1", name: "echo", arguments: arguments_ };
}

function tool(overrides: Partial<EchoTool> = {}): EchoTool {
	return {
		name: "echo",
		label: "Echo",
		description: "Echo input",
		parameters,
		async execute(_toolCallId, args) {
			return {
				content: [{ type: "text", text: args.value }],
				details: { value: args.value },
			};
		},
		...overrides,
	};
}

function text(result: AgentToolResult<unknown>): string {
	return result.content.flatMap((content) => (content.type === "text" ? [content.text] : [])).join("\n");
}

function effectGate(): Gate {
	return createGate().gate;
}

/** Resolve and clear a call exactly like the harness does before publishing its intent. */
function clearedCall(overrides: Partial<EchoTool> = {}): ClearedToolCall<undefined> {
	const prepared = prepareToolCall(call(), [tool(overrides)]);
	if ("kind" in prepared) throw new Error("expected a prepared tool call");
	const cleared = applyBeforeToolDecision(prepared, undefined);
	if ("kind" in cleared) throw new Error("expected a cleared tool call");
	return cleared;
}

const invocation = {
	invocationId: "result-1",
	operationId: "operation-1",
	turnId: "turn-1",
	getMemo: async () => undefined,
	setMemo: async () => {},
};

describe("durable tool-intent settlement", () => {
	it("keeps the tool effect unobservable until the durable intent settles", async () => {
		const observation: string[] = [];
		const durable: { intent?: Record<string, unknown> } = {};
		const execute = vi.fn(async (_toolCallId: string, args: { value: string }) => {
			observation.push(durable.intent === undefined ? "effect:before-settlement" : "effect:after-settlement");
			return { content: [{ type: "text" as const, text: args.value }], details: { value: args.value } };
		});
		const cleared = clearedCall({ execute });

		// Durable intent settlement: commit the cleared arguments plus the effect_pending state
		// to the session. Only the settled result may be observed by the external effect.
		let settleIntent!: () => void;
		const intentSettled = new Promise<void>((resolve) => {
			settleIntent = resolve;
		});

		const run = (async () => {
			await intentSettled;
			durable.intent = cleared.args;
			observation.push("settled:effect_pending");
			return executeToolCall(cleared, effectGate(), () => {}, undefined, invocation, BACKGROUND_CONTEXT);
		})();

		// While settlement is outstanding nothing is observable and the effect is untouched.
		await Promise.resolve();
		expect(observation).toEqual([]);
		expect(durable.intent).toBeUndefined();
		expect(execute).not.toHaveBeenCalled();

		settleIntent();
		const executed = await run;

		expect(observation).toEqual(["settled:effect_pending", "effect:after-settlement"]);
		expect(observation).not.toContain("effect:before-settlement");
		expect(execute).toHaveBeenCalledOnce();
		expect(durable.intent).toEqual({ value: "input" });
		expect(executed.isError).toBe(false);
		expect(text(executed.result)).toBe("input");
	});

	it("never observes the effect when durable intent settlement fails", async () => {
		const observation: string[] = [];
		const execute = vi.fn(async (_toolCallId: string, args: { value: string }) => {
			observation.push("effect");
			return { content: [{ type: "text" as const, text: args.value }], details: { value: args.value } };
		});
		const cleared = clearedCall({ execute });
		const { gate, control } = createGate();

		// The owner closes the gate when settlement fails; admission is refused before entry.
		control.close(new Error("durable intent settlement failed"));

		let thrown: unknown;
		try {
			await executeToolCall(cleared, gate, () => {}, undefined, invocation, BACKGROUND_CONTEXT);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as Error).message).toBe("durable intent settlement failed");
		expect(execute).not.toHaveBeenCalled();
		expect(observation).toEqual([]);
	});
});
