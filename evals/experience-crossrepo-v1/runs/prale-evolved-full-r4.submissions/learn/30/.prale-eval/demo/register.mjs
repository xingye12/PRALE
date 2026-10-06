/**
 * Registers the resolution hooks used by the dependency-free demo runner.
 * Loaded via `node --import ./.prale-eval/demo/register.mjs`.
 */

import { register } from "node:module";

register("./ts-loader.mjs", import.meta.url);
