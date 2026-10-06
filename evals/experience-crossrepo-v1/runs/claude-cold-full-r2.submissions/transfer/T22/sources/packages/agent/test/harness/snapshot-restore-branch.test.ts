import { afterEach, describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import { buildSessionContext } from "../../src/harness/session/context.ts";
import { MemorySessionRepo } from "../../src/harness/session/memory.ts";
import type { LaneConfiguration, Session } from "../../src/harness/session/types.ts";
import { laneConfig, laneState, setValue } from "../../src/harness/session/values.ts";
import type { AgentMessage } from "../../src/types.ts";

const NOW = 1_700_000_000_000;

const configuration: LaneConfiguration = {
	model: { provider: "test", modelId: "model" },
	thinkingLevel: "off",
	activeToolNames: [],
};

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: NOW };
}

const repos: MemorySessionRepo[] = [];

/** A source session whose `main` branch is a configured AgentLane eligible for a branch snapshot. */
async function createConfiguredSession(): Promise<{ repo: MemorySessionRepo; session: Session }> {
	const repo = new MemorySessionRepo({ now: () => NOW });
	repos.push(repo);
	const session = await repo.create({ id: "source" }, BACKGROUND_CONTEXT);
	await session.createBranch("main", null, BACKGROUND_CONTEXT);
	await session.mutate(
		(mutator) =>
			mutator.commit(
				[
					setValue(laneConfig("main"), configuration),
					setValue(laneState("main"), { currentOperationId: null, lastOperationId: null, inbox: [] }),
				],
				BACKGROUND_CONTEXT,
			),
		BACKGROUND_CONTEXT,
	);
	return { repo, session };
}

afterEach(async () => {
	for (const repo of repos.splice(0)) await repo.close(BACKGROUND_CONTEXT);
});

describe("snapshot/restore branch isolation", () => {
	it("restores the snapshot's own branch terminal entry without its sibling branch entry", async () => {
		const { repo, session: source } = await createConfiguredSession();
		const main = await source.branch("main", BACKGROUND_CONTEXT);
		if (main === undefined) throw new Error("Expected the source main branch");

		// One shared root, then two competing children: the branch we snapshot (`main`) and a
		// sibling branch that must stay out of the restored context.
		const rootId = await main.appendMessage(userMessage("shared root"), BACKGROUND_CONTEXT);
		const terminalId = await main.appendMessage(userMessage("restored branch terminal"), BACKGROUND_CONTEXT);

		const sibling = await source.createBranch("sibling", rootId, BACKGROUND_CONTEXT);
		const siblingId = await sibling.appendMessage(userMessage("sibling branch entry"), BACKGROUND_CONTEXT);
		expect(await sibling.getTipId(BACKGROUND_CONTEXT)).toBe(siblingId);
		expect(await main.getTipId(BACKGROUND_CONTEXT)).toBe(terminalId);

		// Snapshot `main` at its terminal entry. The branch-scoped fork is a separate destination
		// session that captures exactly the requested branch ancestry (root + terminal) as one boundary.
		const restored = await repo.fork(
			source.metadata,
			{ id: "restored", scope: "branch", branch: "main", entryId: terminalId },
			BACKGROUND_CONTEXT,
		);

		const restoredMain = await restored.branch("main", BACKGROUND_CONTEXT);
		if (restoredMain === undefined) throw new Error("Expected the restored main branch");

		// The restored branch ends at the expected terminal entry.
		expect(await restoredMain.getTipId(BACKGROUND_CONTEXT)).toBe(terminalId);

		// The sibling branch and its entry were never part of the snapshot.
		expect(await restored.branch("sibling", BACKGROUND_CONTEXT)).toBeUndefined();
		expect(await restored.getEntry(siblingId, BACKGROUND_CONTEXT)).toBeUndefined();

		// Restoring the branch path and projecting it yields the terminal entry's message together
		// with the shared root, and never the sibling branch entry's message.
		const pathEntries = await restoredMain.findEntries({ order: "oldestFirst" }, BACKGROUND_CONTEXT);
		expect(pathEntries.map(({ id }) => id)).toEqual([rootId, terminalId]);

		const messages = await buildSessionContext(pathEntries, undefined, BACKGROUND_CONTEXT);
		const projected = messages.map((message) => JSON.stringify(message));
		expect(projected).toContain(JSON.stringify(userMessage("shared root")));
		expect(projected).toContain(JSON.stringify(userMessage("restored branch terminal")));
		expect(projected).not.toContain(JSON.stringify(userMessage("sibling branch entry")));

		await restored.close(BACKGROUND_CONTEXT);
	});
});
