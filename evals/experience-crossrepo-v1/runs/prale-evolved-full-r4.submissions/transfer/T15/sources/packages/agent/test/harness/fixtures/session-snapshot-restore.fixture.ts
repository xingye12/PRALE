import { pathToFileURL } from "node:url";
import type { Context } from "../../../src/harness/context.ts";
import type { AgentMessage } from "../../../src/types.ts";
import { buildSessionContext } from "../../../src/harness/session/context.ts";
import {
	createForkSnapshot,
	type ForkDestinationSnapshot,
	type ForkSourceSnapshot,
} from "../../../src/harness/session/fork.ts";
import type { Entry, LaneConfiguration } from "../../../src/harness/session/types.ts";
import { branchTip, laneConfig, laneState } from "../../../src/harness/session/values.ts";

/**
 * Separate snapshot/restore fixture.
 *
 * It snapshots one session tree that carries two sibling leaves under a shared
 * root: a terminal entry on the restored `main` branch and a sibling entry on a
 * different branch. Restoring only `main` through `createForkSnapshot` copies
 * the ancestor path up to the terminal entry and drops the sibling. Projecting
 * the restored path through `buildSessionContext` must therefore expose the
 * terminal entry while never exposing the sibling branch entry.
 */

export const SNAPSHOT_NOW = 1_700_000_000_000;
export const RESTORED_BRANCH = "main";
export const SIBLING_BRANCH = "sibling";
export const ROOT_ENTRY_ID = "snapshot-root";
export const TERMINAL_ENTRY_ID = "snapshot-main-terminal";
export const SIBLING_ENTRY_ID = "snapshot-sibling-leaf";
export const TERMINAL_TEXT = "main terminal response";
export const SIBLING_TEXT = "sibling branch response";

const laneConfiguration: LaneConfiguration = {
	model: { provider: "fixture", modelId: "fixture-model" },
	thinkingLevel: "off",
	activeToolNames: [],
};

const idleLaneState = { currentOperationId: null, lastOperationId: null, inbox: [] };

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: SNAPSHOT_NOW };
}

function messageEntry(id: string, parentId: string | null, seq: number, text: string): Entry {
	return { id, parentId, seq, timestamp: SNAPSHOT_NOW, type: "message", message: userMessage(text) };
}

/** The full snapshot boundary: both sibling leaves live in one captured tree. */
export function buildSourceSnapshot(): ForkSourceSnapshot {
	return {
		entries: [
			messageEntry(ROOT_ENTRY_ID, null, 1, "shared root"),
			messageEntry(TERMINAL_ENTRY_ID, ROOT_ENTRY_ID, 2, TERMINAL_TEXT),
			messageEntry(SIBLING_ENTRY_ID, ROOT_ENTRY_ID, 3, SIBLING_TEXT),
		],
		scalarValues: [
			{ address: branchTip(RESTORED_BRANCH), value: TERMINAL_ENTRY_ID, seq: 4 },
			{ address: laneConfig(RESTORED_BRANCH), value: laneConfiguration, seq: 5 },
			{ address: laneState(RESTORED_BRANCH), value: idleLaneState, seq: 6 },
			{ address: branchTip(SIBLING_BRANCH), value: SIBLING_ENTRY_ID, seq: 7 },
			{ address: laneConfig(SIBLING_BRANCH), value: laneConfiguration, seq: 8 },
			{ address: laneState(SIBLING_BRANCH), value: idleLaneState, seq: 9 },
		],
	};
}

/** Restore only the named branch from the captured snapshot. */
export function restoreBranchSnapshot(source: ForkSourceSnapshot): ForkDestinationSnapshot {
	return createForkSnapshot(source, { scope: "branch", branch: RESTORED_BRANCH });
}

/** Restore the whole captured tree (used as the negative control). */
export function restoreTreeSnapshot(source: ForkSourceSnapshot): ForkDestinationSnapshot {
	return createForkSnapshot(source, { scope: "tree" });
}

/** The restored branch's entry path ordered oldest-first, exactly as it would be replayed. */
export function restoredBranchPath(restored: ForkDestinationSnapshot): Entry[] {
	return [...restored.entries.values()].sort((left, right) => left.seq - right.seq);
}

/** The restored branch tip as projected from the snapshot's scalar values. */
export function restoredBranchTip(restored: ForkDestinationSnapshot): string | null {
	const tip = restored.scalarValues.find(
		(stored) => stored.address.namespace === branchTip("").namespace && stored.address.key === RESTORED_BRANCH,
	);
	return tip === undefined ? null : (tip.value as string | null);
}

export interface SnapshotRestoreResult {
	restoredBranch: string;
	restoredTipId: string | null;
	restoredEntryIds: string[];
	treeEntryIds: string[];
	restoredContextTexts: string[];
	restoredContextRoles: string[];
	seesTerminalEntry: boolean;
	seesSiblingEntry: boolean;
	treeRestoreSeesSiblingEntry: boolean;
}

function assert(condition: boolean, message: string): void {
	if (!condition) throw new Error(`snapshot/restore fixture failed: ${message}`);
}

/**
 * Run the fixture and assert the restored-branch contract. Throws on any
 * violation, so it is both an executable demo and a reusable test helper.
 */
export async function runSnapshotRestoreFixture(context?: Context): Promise<SnapshotRestoreResult> {
	const projectionContext = context ?? ({} as Context);
	const source = buildSourceSnapshot();
	const restored = restoreBranchSnapshot(source);
	const restoredEntryIds = restoredBranchPath(restored).map((entry) => entry.id);
	const restoredTipId = restoredBranchTip(restored);
	const messages = await buildSessionContext(restoredBranchPath(restored), undefined, projectionContext);
	const restoredContextTexts = messages
		.filter((message) => message.role === "user")
		.flatMap((message) => (typeof message.content === "string" ? [message.content] : []))
		.concat(
			messages
				.filter((message) => message.role === "user")
				.flatMap((message) =>
					typeof message.content === "string"
						? []
						: message.content.filter((part) => part.type === "text").map((part) => part.text),
				),
		);
	const tree = restoreTreeSnapshot(source);
	const treeEntryIds = [...tree.entries.keys()].sort();
	const seesTerminalEntry = restoredContextTexts.includes(TERMINAL_TEXT);
	const seesSiblingEntry = restoredContextTexts.includes(SIBLING_TEXT);
	const treeRestoreSeesSiblingEntry = treeEntryIds.includes(SIBLING_ENTRY_ID);

	assert(restoredTipId === TERMINAL_ENTRY_ID, `restored tip ${restoredTipId} is not the terminal entry`);
	assert(restoredEntryIds.includes(TERMINAL_ENTRY_ID), "restored branch is missing its terminal entry");
	assert(!restoredEntryIds.includes(SIBLING_ENTRY_ID), "restored branch leaked the sibling entry");
	assert(seesTerminalEntry, "restored branch context is missing the terminal entry message");
	assert(!seesSiblingEntry, "restored branch context leaked the sibling branch message");
	assert(treeRestoreSeesSiblingEntry, "tree restore control should retain the sibling entry");

	return {
		restoredBranch: RESTORED_BRANCH,
		restoredTipId,
		restoredEntryIds,
		treeEntryIds,
		restoredContextTexts,
		restoredContextRoles: messages.map((message) => message.role),
		seesTerminalEntry,
		seesSiblingEntry,
		treeRestoreSeesSiblingEntry,
	};
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const result = await runSnapshotRestoreFixture();
	console.log(JSON.stringify(result, null, 2));
}
