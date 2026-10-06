/**
 * Dependency-free runner for the repository's fake-transport interaction test.
 *
 * It registers the resolution hooks in `ts-loader.mjs` (so `.js` imports map
 * to the real `.ts` sources and `vitest` maps to the local shim), imports the
 * actual test file `sdk/memory-core/typescript/tests/fake-transport-interaction.test.ts`,
 * runs every case, prints a normalized JSON result and exits non-zero on any
 * failure.
 *
 * Usage (from the workspace root):
 *   node --experimental-transform-types --no-warnings \
 *     --import ./.prale-eval/demo/register.mjs \
 *     ./.prale-eval/demo/run-fake-transport-interaction.mjs
 */

import { run } from "./vitest-shim.mjs";

const TEST_FILE = new URL(
  "../../sdk/memory-core/typescript/tests/fake-transport-interaction.test.ts",
  import.meta.url,
).href;

await import(TEST_FILE);

const results = await run();
const failed = results.filter((entry) => entry.status === "failed");
const summary = {
  suite: "fake-transport-interaction",
  total: results.length,
  passed: results.length - failed.length,
  failed: failed.length,
  cases: results,
};

console.log(JSON.stringify(summary, null, 2));
if (failed.length > 0) {
  process.exitCode = 1;
}
