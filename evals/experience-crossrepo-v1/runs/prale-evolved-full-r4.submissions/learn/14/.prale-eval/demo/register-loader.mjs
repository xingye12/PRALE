/**
 * register-loader.mjs — preload entry (`node --import ...`) that installs loader.mjs
 * before the demo entry module (and its `.ts` imports) are evaluated.
 */
import { register } from "node:module";

register("./loader.mjs", import.meta.url);
