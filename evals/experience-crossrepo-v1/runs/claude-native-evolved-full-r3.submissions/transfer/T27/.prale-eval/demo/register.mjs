/** Registers the SDK resolution hooks before the demo entrypoint loads. */
import { register } from "node:module";

register("./loader.mjs", import.meta.url);
