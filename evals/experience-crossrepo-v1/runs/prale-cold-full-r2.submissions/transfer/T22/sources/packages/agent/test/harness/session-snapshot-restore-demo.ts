import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentMessage } from "../../src/types.ts";
import type { Context } from "../../src/harness/context.ts";
import { insertEntry } from "../../src/harness/session/commit.ts";
import { buildSessionContext } from "../../src/harness/session/context.ts";
import { createForkSnapshot, type ForkSourceSnapshot } from "../../src/harness/session/fork.ts";
import { InMemoryStorageState } from "../../src/harness/session/in-memory-storage-state.ts";
import type { Entry, ForkOptions, NewEntry, Write } from "../../src/harness/session/types.ts";
import { branchTip, setValue, value as valueAddress } from "../../src/harness/session/values.ts";

/** Detached source snapshot restored by the demo; it is data only, never a live session. */
export const SNAPSHOT_FIXTURE_URL = new URL("./fixtures/session-snapshot-restore.json", import.meta.url);
export const RESTORED_BRANCH = "main";
export const SIBLING_BRANCH = "sibling";
export const ROOT_ENTRY_ID = "root";
export const TERMINAL_ENTRY_ID = "main-terminal";
export const SIBLING_ENTRY_ID = "sibling";
export const TERMINAL_TEXT = "main branch terminal answer";
export const SIBLING_TEXT = "sibling branch answer";

/**
 * The fixture registers no custom-entry projector, so buildSessionContext never reads its context.
 * A plain object keeps the demo runnable without transport or telemetry dependencies.
 */
const DEMO_CONTEXT = {} as Context;

export function loadSnapshotFixture(url: URL = SNAPSHOT_FIXTURE_URL): ForkSourceSnapshot {
	const parsed: unknown = JSON.parse(readFileSync(url, "utf8"));
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error(`Snapshot fixture ${fileURLToPath(url)} must contain a JSON object`);
	}
	const candidate = parsed as Partial<ForkSourceSnapshot>;
	if (!Array.isArray(candidate.entries) || !Array.isArray(candidate.scalarValues)) {
		throw new Error(`Snapshot fixture ${fileURLToPath(url)} must contain "entries" and "scalarValues" arrays`);
	}
	return {
		entries: candidate.entries,
		scalarValues: candidate.scalarValues,
		entriesComplete: candidate.entriesComplete,
	};
}

/** Materialize a fork snapshot into a fresh storage state through the normal commit path. */
export function restoreSnapshot(snapshot: ForkSourceSnapshot, options: ForkOptions): InMemoryStorageState {
	const destination = createForkSnapshot(snapshot, options);
	const state = new InMemoryStorageState();
	const entries = [...destination.entries.values()].sort((left, right) => left.seq - right.seq);
	const writes: Write[] = [
		...entries.map((entry) => {
			const { seq: _seq, timestamp: _timestamp, ...rest } = entry;
			return insertEntry(rest as NewEntry);
		}),
		...destination.scalarValues.map((stored) =>
			setValue(valueAddress(stored.address.namespace, stored.address.key), stored.value),
		),
	];
	const prepared = state.prepareCommit(writes, 1);
	state.applyValidated(prepared.writes);
	state.advanceNextSeq(destination.nextSeq);
	return state;
}

/** Walk one restored branch from its restored tip back to the branch root, oldest entry first. */
export function restoredBranchPath(
	state: InMemoryStorageState,
	branchName: string,
): { tipId: string | null; entries: Entry[] } {
	const tipId = state.getValue(branchTip(branchName))?.value ?? null;
	if (tipId === null) return { tipId, entries: [] };
	return { tipId, entries: state.scanBranch({ start: tipId, order: "oldestFirst" }) };
}

function messageTexts(messages: readonly AgentMessage[]): string[] {
	const texts: string[] = [];
	for (const message of messages) {
		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (
				typeof part === "object" &&
				part !== null &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string"
			) {
				texts.push((part as { text: string }).text);
			}
		}
	}
	return texts;
}

export interface RestoredBranchObservation {
	scope: ForkOptions["scope"];
	branchName: string;
	branchTipId: string | null;
	branchPathEntryIds: string[];
	restoredEntryIds: string[];
	siblingEntryPresentInRestore: boolean;
	terminalEntryHasTerminateFlag: boolean;
	contextTexts: string[];
	contextSeesTerminalText: boolean;
	contextSeesSiblingText: boolean;
	siblingBranchPathEntryIds: string[] | null;
	siblingContextTexts: string[] | null;
}

export interface SnapshotRestoreDemoResult {
	fixturePath: string;
	restoredBranch: string;
	siblingBranch: string;
	terminalEntryId: string;
	siblingEntryId: string;
	observations: RestoredBranchObservation[];
}

async function observeRestore(snapshot: ForkSourceSnapshot, options: ForkOptions): Promise<RestoredBranchObservation> {
	const state = restoreSnapshot(snapshot, options);
	const branch = restoredBranchPath(state, RESTORED_BRANCH);
	const contextTexts = messageTexts(await buildSessionContext(branch.entries, undefined, DEMO_CONTEXT));
	const restoredEntryIds = state.scanEntries({}).map((entry) => entry.id);
	const terminal = state.getEntries([TERMINAL_ENTRY_ID]).get(TERMINAL_ENTRY_ID);

	const siblingBranch = restoredBranchPath(state, SIBLING_BRANCH);
	const siblingContextTexts =
		siblingBranch.tipId === null
			? null
			: messageTexts(await buildSessionContext(siblingBranch.entries, undefined, DEMO_CONTEXT));

	return {
		scope: options.scope,
		branchName: RESTORED_BRANCH,
		branchTipId: branch.tipId,
		branchPathEntryIds: branch.entries.map((entry) => entry.id),
		restoredEntryIds,
		siblingEntryPresentInRestore: restoredEntryIds.includes(SIBLING_ENTRY_ID),
		terminalEntryHasTerminateFlag: terminal?.type === "message" && terminal.terminate === true,
		contextTexts,
		contextSeesTerminalText: contextTexts.includes(TERMINAL_TEXT),
		contextSeesSiblingText: contextTexts.includes(SIBLING_TEXT),
		siblingBranchPathEntryIds: siblingBranch.tipId === null ? null : siblingBranch.entries.map((entry) => entry.id),
		siblingContextTexts,
	};
}

function assertObservation(observation: RestoredBranchObservation): void {
	const scope = observation.scope;
	const fail = (detail: string): never => {
		throw new Error(`snapshot/restore demo (${scope} scope) failed: ${detail}`);
	};

	if (observation.branchTipId !== TERMINAL_ENTRY_ID) {
		fail(`restored ${RESTORED_BRANCH} tip is ${JSON.stringify(observation.branchTipId)}`);
	}
	if (observation.branchPathEntryIds.join(",") !== `${ROOT_ENTRY_ID},${TERMINAL_ENTRY_ID}`) {
		fail(`restored ${RESTORED_BRANCH} path is ${JSON.stringify(observation.branchPathEntryIds)}`);
	}
	if (!observation.terminalEntryHasTerminateFlag) {
		fail(`restored terminal entry ${TERMINAL_ENTRY_ID} lost its terminate flag`);
	}
	if (!observation.contextSeesTerminalText) {
		fail(`restored ${RESTORED_BRANCH} context is missing ${JSON.stringify(TERMINAL_TEXT)}`);
	}
	if (observation.contextSeesSiblingText) {
		fail(`restored ${RESTORED_BRANCH} context leaked sibling text ${JSON.stringify(SIBLING_TEXT)}`);
	}
	if (scope === "tree") {
		if (!observation.siblingEntryPresentInRestore) {
			fail(`tree restore dropped sibling entry ${SIBLING_ENTRY_ID}`);
		}
		if (observation.siblingBranchPathEntryIds?.join(",") !== `${ROOT_ENTRY_ID},${SIBLING_ENTRY_ID}`) {
			fail(`restored ${SIBLING_BRANCH} path is ${JSON.stringify(observation.siblingBranchPathEntryIds)}`);
		}
		if (observation.siblingContextTexts?.includes(SIBLING_TEXT) !== true) {
			fail(`restored ${SIBLING_BRANCH} context is missing its own entry`);
		}
		if (observation.siblingContextTexts?.includes(TERMINAL_TEXT) === true) {
			fail(`restored ${SIBLING_BRANCH} context leaked terminal text from ${RESTORED_BRANCH}`);
		}
	} else if (observation.siblingEntryPresentInRestore) {
		fail(`branch restore copied sibling entry ${SIBLING_ENTRY_ID}`);
	}
}

/**
 * Restore the detached snapshot fixture twice: a whole-tree restore (both branches present) and a
 * branch-scoped restore (only the restored branch present), asserting in both cases that the
 * restored branch context reaches its terminal entry and never the sibling branch entry.
 */
export async function runSnapshotRestoreDemo(
	snapshot: ForkSourceSnapshot = loadSnapshotFixture(),
): Promise<SnapshotRestoreDemoResult> {
	const observations: RestoredBranchObservation[] = [];
	for (const scope of ["tree", "branch"] as const) {
		const options: ForkOptions = scope === "tree" ? { scope: "tree" } : { scope: "branch", branch: RESTORED_BRANCH };
		const observation = await observeRestore(snapshot, options);
		assertObservation(observation);
		observations.push(observation);
	}
	return {
		fixturePath: fileURLToPath(SNAPSHOT_FIXTURE_URL),
		restoredBranch: RESTORED_BRANCH,
		siblingBranch: SIBLING_BRANCH,
		terminalEntryId: TERMINAL_ENTRY_ID,
		siblingEntryId: SIBLING_ENTRY_ID,
		observations,
	};
}

const directEntryPoint = process.argv[1] === undefined ? undefined : pathToFileURL(process.argv[1]).href;
if (import.meta.url === directEntryPoint) {
	console.log(JSON.stringify(await runSnapshotRestoreDemo(), null, "\t"));
}
