import { describe, expect, it } from "vitest";
import { BACKGROUND_CONTEXT } from "../../src/harness/context.ts";
import {
	RESTORED_BRANCH,
	SIBLING_ENTRY_ID,
	TERMINAL_ENTRY_ID,
	TERMINAL_TEXT,
	SIBLING_TEXT,
	runSnapshotRestoreFixture,
} from "./fixtures/session-snapshot-restore.fixture.ts";

describe("session snapshot/restore fixture", () => {
	it("restores the branch terminal entry without leaking the sibling branch entry", async () => {
		const result = await runSnapshotRestoreFixture(BACKGROUND_CONTEXT);

		expect(result.restoredBranch).toBe(RESTORED_BRANCH);
		expect(result.restoredTipId).toBe(TERMINAL_ENTRY_ID);
		expect(result.restoredEntryIds).toContain(TERMINAL_ENTRY_ID);
		expect(result.restoredEntryIds).not.toContain(SIBLING_ENTRY_ID);
		expect(result.restoredContextTexts).toContain(TERMINAL_TEXT);
		expect(result.restoredContextTexts).not.toContain(SIBLING_TEXT);
		expect(result.seesTerminalEntry).toBe(true);
		expect(result.seesSiblingEntry).toBe(false);
		// Negative control: the same snapshot restored as a whole tree retains the sibling.
		expect(result.treeEntryIds).toContain(SIBLING_ENTRY_ID);
		expect(result.treeRestoreSeesSiblingEntry).toBe(true);
	});
});
