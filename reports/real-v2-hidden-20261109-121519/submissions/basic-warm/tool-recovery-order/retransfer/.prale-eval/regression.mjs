import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRecoverySubject } from "./subject.mjs";

// Load the real production recovery module through the read-only boundary helper.
// The helper replaces checkpoint IO, tool execution, and outcome publication with
// observable fakes; every unexpected boundary call throws.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const recover = await createRecoverySubject(root);

const normalize = (value) => JSON.parse(JSON.stringify(value));

const checkpointText = "durable-progress";
assert.match(checkpointText, /durable-progress/, "checkpoint fixture text must be the durable snapshot");

// 1. A cancelled batch must never clear the replay checkpoint or invoke the tool,
//    even when both the recorded call and the tool declare replay "safe". It must
//    publish the durable checkpoint plus the interruption marker instead.
let cancelledEffects = 0;
const cancelled = await recover("safe", "safe", true, {
	effect: () => {
		cancelledEffects += 1;
	},
});

assert.deepEqual(
	cancelled.events,
	["read", "publish"],
	`cancelled safe/safe recovery must only read the checkpoint and publish evidence, got ${JSON.stringify(cancelled.events)}`,
);
assert.equal(cancelledEffects, 0, "cancelled safe/safe recovery must not perform the tool effect");
assert.equal(cancelled.outcome !== undefined, true, "cancelled recovery must publish an outcome");

const cancelledMessage = cancelled.outcome.message;
assert.equal(cancelledMessage.isError, true, "interrupted evidence must be marked as an error result");
const cancelledContent = normalize(cancelledMessage.content);
assert.deepEqual(
	cancelledContent[0],
	{ type: "text", text: checkpointText },
	"interrupted evidence must retain the durable checkpoint content",
);
assert.equal(cancelledContent.length, 2, "interrupted evidence must append exactly one marker");
assert.equal(cancelledContent[1].type, "text");
assert.match(
	cancelledContent[1].text,
	/external outcome is unknown/,
	"interrupted evidence must explain that the external outcome is unknown",
);
assert.deepEqual(
	normalize(cancelledMessage.details),
	{ step: 2 },
	"interrupted evidence must retain checkpoint details",
);
assert.equal(
	cancelledContent.some((part) => part.text === "effect-result"),
	false,
	"cancelled recovery must not publish a live effect result",
);

// 2. A non-cancelled safe/safe recovery must replay exactly once: clear the
//    checkpoint, invoke the tool once, and settle the outcome after completion.
let replayedEffects = 0;
const replayed = await recover("safe", "safe", false, {
	effect: () => {
		replayedEffects += 1;
	},
});

assert.deepEqual(
	replayed.events,
	["clear", "invoke", "effect-complete", "publish"],
	`non-cancelled safe/safe recovery must clear, invoke once, and publish, got ${JSON.stringify(replayed.events)}`,
);
assert.equal(replayedEffects, 1, "non-cancelled safe/safe recovery must execute the effect exactly once");
assert.equal(
	replayed.events.filter((event) => event === "invoke").length,
	1,
	"non-cancelled safe/safe recovery must invoke the tool exactly once",
);
assert.equal(
	replayed.events.filter((event) => event === "clear").length,
	1,
	"non-cancelled safe/safe recovery must clear the replay checkpoint exactly once",
);
assert.equal(
	replayed.events.at(-1),
	"publish",
	"non-cancelled replay must settle by publishing the completed outcome",
);

const replayedMessage = replayed.outcome.message;
assert.equal(replayedMessage.isError, false, "successful replay must publish the live, non-error result");
assert.deepEqual(
	normalize(replayedMessage.content),
	[{ type: "text", text: "effect-result" }],
	"successful replay must publish the tool's live result rather than interrupted evidence",
);

// 3. An unsafe (or absent) tool must still publish interrupted evidence, and
//    cancellation must not change that behavior.
for (const cancelledFlag of [true, false]) {
	const interrupted = await recover("never", "safe", cancelledFlag, {
		effect: () => {
			throw new Error("unsafe recovery must never execute the tool");
		},
	});
	assert.deepEqual(
		interrupted.events,
		["read", "publish"],
		`non-replayable recovery (cancelled=${cancelledFlag}) must only read and publish`,
	);
	assert.match(
		normalize(interrupted.outcome.message.content).at(-1).text,
		/external outcome is unknown/,
		`non-replayable recovery (cancelled=${cancelledFlag}) must publish interrupted evidence`,
	);
}

console.log("regression passed: cancellation prevents safe/safe replay; non-cancelled replay settles once");
