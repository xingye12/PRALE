// Minimal stand-in for the `cross-spawn` runtime dependency (not installed in this workspace).
// Only reached through utils/child-process.ts, which the precedence demo never calls.
import { spawn, spawnSync } from "node:child_process";

const crossSpawn = (command, args, options) => spawn(command, args, options);
crossSpawn.sync = (command, args, options) => spawnSync(command, args, options);

export default crossSpawn;
