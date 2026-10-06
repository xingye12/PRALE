// Registers the offline stub hooks; used via `node --import ./.prale-eval/demo/register.mjs`.
import { register } from "node:module";

register("./hooks.mjs", import.meta.url);
