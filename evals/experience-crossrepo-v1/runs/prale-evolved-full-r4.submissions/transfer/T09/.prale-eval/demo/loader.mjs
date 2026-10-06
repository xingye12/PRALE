/**
 * Minimal Node module-resolution hook so this demo can import the repository's
 * TypeScript SDK sources directly, with no dependency installation.
 *
 * Two remaps are required because the SDK sources are authored for a bundler
 * (tsc / vitest), not for Node's native type-stripping loader:
 *   1. Bare `undici` -> local no-op stub. `src/v3/http.ts` imports `Agent` at
 *      module scope, but only constructs it when `rejectUnauthorized === false`.
 *      The demo uses the default (secure) path, so the stub is never used.
 *   2. Internal `./*.js` specifiers -> the sibling `*.ts` source, matching the
 *      NodeNext-style import convention used throughout the SDK.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, next) {
  if (specifier === "undici") {
    return { url: new URL("./undici-stub.mjs", import.meta.url).href, shortCircuit: true };
  }
  if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
    const target = new URL(specifier, context.parentURL);
    if (!existsSync(fileURLToPath(target))) {
      const tsUrl = new URL(target.href.slice(0, -".js".length) + ".ts");
      if (existsSync(fileURLToPath(tsUrl))) {
        return { url: tsUrl.href, shortCircuit: true };
      }
    }
  }
  return next(specifier, context);
}
