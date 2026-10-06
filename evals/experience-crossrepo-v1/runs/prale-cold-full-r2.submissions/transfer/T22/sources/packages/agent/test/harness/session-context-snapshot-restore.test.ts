import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import { buildSessionContext } from "../../src/harness/session/context.ts";
import {
	ROOT_ENTRY_ID,
	RESTORED_BRANCH,
	SIBLING_BRANCH,
	SIBLING_ENTRY_ID,
	SIBLING_TEXT,
	TERMINAL_ENTRY_ID,
	TERMINAL_TEXT,
	loadSnapshotFixture,
	restoredBranchPath,
	restoreSnapshot,
	runSnapshotRestoreDemo,
} from "./session-snapshot-restore-demo.ts";

describe("session context over a restored snapshot fixture", () => {
	it("restores the fixture branch and projects its terminal entry", async () => {
		const { observations } = await runSnapshotRestoreDemo();
		const [tree] = observations;

		expect(tree).toBeDefined();
		expect(tree?.scope).toBe("tree");
		expect(tree?.branchTipId).toBe(TERMINAL_ENTRY_ID);
		expect(tree?.branchPathEntryIds).toEqual([ROOT_ENTRY_ID, TERMINAL_ENTRY_ID]);
		expect(tree?.terminalEntryHasTerminateFlag).toBe(true);
		expect(tree?.contextSeesTerminalText).toBe(true);
	});

	it("keeps the sibling branch entry out of the restored branch context", async () => {
		const snapshot = loadSnapshotFixture();
		const state = restoreSnapshot(snapshot, { scope: "tree" });
		const restored = restoredBranchPath(state, RESTORED_BRANCH);
		const sibling = restoredBranchPath(state, SIBLING_BRANCH);

		// The sibling entry survives the whole-tree restore and belongs to its own branch only.
		expect(restored.entries.map((entry) => entry.id)).not.toContain(SIBLING_ENTRY_ID);
		expect(sibling.entries.map((entry) => entry.id)).toEqual([ROOT_ENTRY_ID, SIBLING_ENTRY_ID]);

		const context = await buildSessionContext(restored.entries, undefined, BACKGROUND_CONTEXT);
		const texts = context.flatMap((message) =>
			Array.isArray(message.content)
				? message.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
				: [],
		);

		expect(texts).toContain(TERMINAL_TEXT);
		expect(texts).not.toContain(SIBLING_TEXT);
	});

	it("restores a branch-scoped snapshot without copying the sibling entry", async () => {
		const snapshot = loadSnapshotFixture();
		const state = restoreSnapshot(snapshot, { scope: "branch", branch: RESTORED_BRANCH });

		expect(state.scanEntries({}).map((entry) => entry.id)).toEqual([ROOT_ENTRY_ID, TERMINAL_ENTRY_ID]);
		expect(restoredBranchPath(state, SIBLING_BRANCH).tipId).toBeNull();

		const context = await buildSessionContext(
			restoredBranchPath(state, RESTORED_BRANCH).entries,
			undefined,
			BACKGROUND_CONTEXT,
		);
		expect(context).toHaveLength(2);
	});
});
