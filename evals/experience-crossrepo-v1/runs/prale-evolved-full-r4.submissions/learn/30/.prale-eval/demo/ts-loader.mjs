/**
 * Resolution hooks so Node can execute the TypeScript SDK sources in place,
 * with no install step:
 *
 *   - relative `./x.js` specifiers resolve to the real sibling `x.ts` file
 *     (the SDK uses `.js` extension imports with `moduleResolution: bundler`);
 *   - the `undici` import is answered by a tiny stub, because this checkout
 *     has no `node_modules` and `HttpTransport` only touches `undici` for TLS.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const UNDICI_STUB = new URL("./undici-stub.mjs", import.meta.url).href;
const VITEST_SHIM = new URL("./vitest-shim.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "undici") {
    return { url: UNDICI_STUB, shortCircuit: true, format: "module" };
  }
  if (specifier === "vitest") {
    return { url: VITEST_SHIM, shortCircuit: true, format: "module" };
  }
  if (specifier.endsWith(".js") && (specifier.startsWith("./") || specifier.startsWith("../"))) {
    const asTs = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
    if (existsSync(fileURLToPath(asTs))) {
      return nextResolve(asTs.href, context);
    }
  }
  return nextResolve(specifier, context);
}
