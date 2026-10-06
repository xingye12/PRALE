/**
 * Minimal Node module-resolution hooks so the *un-built* TypeScript SDK sources
 * (`sdk/memory-core/typescript/src/**`) can be imported directly by the demo.
 *
 * Two gaps have to be bridged:
 *
 *  1. The SDK is authored with `moduleResolution: "bundler"` and uses specifiers
 *     that end in `.js` while the files on disk are `.ts` (e.g. `v3/client.ts`
 *     imports `"../errors.js"`). Node's native type-stripping does not rewrite
 *     those specifiers, so map `./x.js` -> `./x.ts` when only the `.ts` file
 *     exists.
 *  2. `src/v3/http.ts` statically imports `undici` (an npm runtime dependency
 *     that is not installed in this checkout and must not be installed here).
 *     A tiny local stub keeps the import graph loadable. The demo never takes
 *     the TLS-dispatcher path that actually uses `Agent`.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const UNDICI_STUB = new URL("./undici-stub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "undici") {
    return { url: UNDICI_STUB, shortCircuit: true };
  }

  if (context.parentURL && specifier.startsWith(".") && specifier.endsWith(".js")) {
    const asJs = new URL(specifier, context.parentURL);
    const asTs = new URL(`${specifier.slice(0, -".js".length)}.ts`, context.parentURL);
    if (!existsSync(fileURLToPath(asJs)) && existsSync(fileURLToPath(asTs))) {
      return { url: asTs.href, shortCircuit: true };
    }
  }

  return nextResolve(specifier, context);
}
