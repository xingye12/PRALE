// Executes the new table-driven "settings precedence" test from the real
// packages/coding-agent/test/settings-manager.test.ts source through the vitest-compatible shim.
import { runRegistered } from "./vitest-shim.mjs";

await import("../../packages/coding-agent/test/settings-manager.test.ts");
await runRegistered("project value wins over user/default");
