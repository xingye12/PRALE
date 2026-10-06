/**
 * Minimal offline ESM resolution hook so the contract demo can load the SDK's
 * TypeScript sources with Node's built-in type stripping (`node file.mjs`):
 *
 *  1. `undici` is a declared runtime dependency of the SDK (`src/v3/http.ts`
 *     statically imports `Agent`), but it is not installed in this offline
 *     workspace. The demo never constructs the TLS-relaxing `Agent` (it only
 *     exercises validation and response normalization), so it is replaced by a
 *     side-effect-free stub.
 *  2. The SDK sources use TS/NodeNext style `./foo.js` specifiers that point at
 *     `./foo.ts` on disk; Node's type stripping does not rewrite them, so the
 *     hook maps them explicitly.
 *
 * No repository source file is modified by this hook.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, next) {
  if (specifier === "undici") {
    return { url: new URL("./undici-shim.mjs", import.meta.url).href, shortCircuit: true };
  }
  if (specifier.endsWith(".js") && context.parentURL?.endsWith(".ts")) {
    const candidate = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
    if (existsSync(fileURLToPath(candidate))) {
      return { url: candidate.href, shortCircuit: true };
    }
  }
  return next(specifier, context);
}
