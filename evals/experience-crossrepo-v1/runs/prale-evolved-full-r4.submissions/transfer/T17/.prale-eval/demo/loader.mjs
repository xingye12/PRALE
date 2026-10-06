/**
 * Node module-resolution hook used by the contract demo.
 *
 * Two adjustments are required to load the *real, unmodified* TypeScript
 * sources with Node's native type stripping (no build step, no `tsc`, no
 * installed toolchain):
 *
 *   1. ESM sources in this SDK use TypeScript's "bundler" convention of
 *      writing `./errors.js` while the on-disk file is `./errors.ts`. Node
 *      does not rewrite `.js` -> `.ts`, so when the requested `.js` file does
 *      not exist but a sibling `.ts` does, resolve to the `.ts` file.
 *   2. The bare specifier `undici` is not installed; map it to a local shim.
 *
 * Anything else falls through to Node's default resolver untouched.
 */

import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const SHIM_URL = new URL("./undici-shim.mjs", import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === "undici") {
    return { url: SHIM_URL, shortCircuit: true };
  }
  try {
    return await next(specifier, context);
  } catch (err) {
    if (err?.code === "ERR_MODULE_NOT_FOUND") {
      const parentPath = context.parentURL ? fileURLToPath(context.parentURL) : process.cwd();
      const candidate = fileURLToPath(new URL(specifier, pathToFileURL(parentPath)));
      if (candidate.endsWith(".js")) {
        const tsCandidate = candidate.slice(0, -3) + ".ts";
        if (existsSync(tsCandidate)) {
          return { url: pathToFileURL(tsCandidate).href, shortCircuit: true };
        }
      }
    }
    throw err;
  }
}
