/**
 * Node module-resolution hooks so the unbuilt TypeScript SDK can be executed
 * directly by the bundled Node runtime (no `tsc`, no `tsx`, no `node_modules`).
 *
 * Two rewrites:
 *   1. bare `undici`            -> ./undici-shim.mjs   (dependency not installed)
 *   2. `./x.js` not on disk     -> `./x.ts`            (repo uses TS "nodenext"
 *                                                       `.js` specifiers that
 *                                                       only exist as `.ts` source)
 *
 * Rewrite 2 only fires after the default resolver reports the module missing,
 * so real `.js` files keep resolving normally.
 */
import { pathToFileURL } from "node:url";

const SHIM = new URL("./undici-shim.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "undici") {
    return { url: SHIM, format: "module", shortCircuit: true };
  }

  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (
      err?.code === "ERR_MODULE_NOT_FOUND" &&
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      specifier.endsWith(".js")
    ) {
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
    throw err;
  }
}
