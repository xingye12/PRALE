// Resolver shim so the real harness sources can run under plain node with type
// stripping, without a node_modules install. Maps the workspace package
// specifiers the harness graph actually value-imports to their source entries
// (same mapping as packages/agent/vitest.harness.config.ts).
import { pathToFileURL } from "node:url";

const workspace = new URL("../../", import.meta.url);
const src = (relative) => new URL(relative, workspace).pathname;

const MAP = new Map([
	["@earendil-works/pi-ai/utils/uuid", src("packages/ai/src/utils/uuid.ts")],
	["@earendil-works/pi-ai", src("packages/ai/src/index.ts")],
	["@earendil-works/pi-telemetry", src("packages/telemetry/src/index.ts")],
	["@earendil-works/chord", src("packages/chord/src/index.ts")],
	["@earendil-works/chord/context", src("packages/chord/src/context/index.ts")],
	["@earendil-works/pi-agent-core", src("packages/agent/src/index.ts")],
]);

export async function resolve(specifier, context, nextResolve) {
	const target = MAP.get(specifier);
	if (target !== undefined) {
		return { url: pathToFileURL(target).href, shortCircuit: true };
	}
	return nextResolve(specifier, context);
}
