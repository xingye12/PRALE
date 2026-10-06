// Dependency-free module loader for the contract demo.
//
// 1. Maps the bare specifier `undici` to a local shim (the package is not
//    installed in this workspace and we must not install it).
// 2. Rewrites relative `./x.js` specifiers to `./x.ts` when the `.js` file
//    does not exist, mirroring the project's TS `NodeNext` source layout so
//    Node's native type-stripping can load the real SDK sources.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const UNDICI_SHIM = new URL("./undici-shim.mjs", import.meta.url).href;

export async function resolve(specifier, context, next) {
  if (specifier === "undici") {
    return next(UNDICI_SHIM, context);
  }
  if (
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    specifier.endsWith(".js") &&
    context.parentURL
  ) {
    const asJs = new URL(specifier, context.parentURL);
    if (!existsSync(fileURLToPath(asJs))) {
      const asTs = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
      if (existsSync(fileURLToPath(asTs))) {
        return next(asTs.href, context);
      }
    }
  }
  return next(specifier, context);
}
