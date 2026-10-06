/**
 * Demo entrypoint: register the SDK resolution hooks, then run the TypeScript
 * demo (`demo.mts`) against a local fake HTTP backend.
 *
 * Usage:  node ./.prale-eval/demo/run-demo.mjs
 *
 * The SDK sources use TypeScript parameter properties (see `IsolationContext`
 * in `src/v3/client.ts`), which Node can only execute in "transform" mode, so
 * this entrypoint re-executes itself with `--experimental-transform-types`
 * when the flag is missing. No build step and no dependencies are required.
 */
import { spawnSync } from "node:child_process";
import { register } from "node:module";
import { fileURLToPath } from "node:url";

const TRANSFORM_FLAG = "--experimental-transform-types";

if (!process.execArgv.includes(TRANSFORM_FLAG)) {
  const child = spawnSync(
    process.execPath,
    [TRANSFORM_FLAG, ...process.execArgv, fileURLToPath(import.meta.url), ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  process.exit(child.status ?? 1);
}

register("./sdk-resolve-hooks.mjs", import.meta.url);

await import("./demo.mts");
