// Node module hooks that redirect the third-party runtime dependencies of
// packages/coding-agent/src/core/settings-manager.ts to local stubs. This lets the precedence
// demo load the real SettingsManager source without installing dependencies.
const STUBS = new Map([
	["proper-lockfile", new URL("./stubs/proper-lockfile.mjs", import.meta.url).href],
	["cross-spawn", new URL("./stubs/cross-spawn.mjs", import.meta.url).href],
	["undici", new URL("./stubs/undici.mjs", import.meta.url).href],
	["@earendil-works/pi-ai", new URL("./stubs/pi-ai.mjs", import.meta.url).href],
	["vitest", new URL("./vitest-shim.mjs", import.meta.url).href],
]);

export async function resolve(specifier, context, nextResolve) {
	const stub = STUBS.get(specifier);
	if (stub) {
		return { url: stub, shortCircuit: true };
	}
	return nextResolve(specifier, context);
}
