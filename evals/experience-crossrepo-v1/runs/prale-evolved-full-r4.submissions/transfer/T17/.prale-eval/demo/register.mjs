/** Registers the local loader before the contract demo graph is evaluated. */
import { register } from "node:module";

register("./loader.mjs", import.meta.url);
