/**
 * Minimal Node ESM resolve hook: lets Node's native TypeScript support load
 * this repo's source, which uses `./x.js` specifiers that actually exist on
 * disk as `x.ts` (the project's tsc/vitest convention).
 *
 * Loaded by run-fake-client-demo.mjs via module.register(); it is a validation
 * aid only and does not participate in the package build.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") && specifier.endsWith(".js")) {
    const parent = context.parentURL
      ? fileURLToPath(context.parentURL)
      : process.cwd();
    const candidate = path.resolve(path.dirname(parent), `${specifier.slice(0, -3)}.ts`);
    if (existsSync(candidate)) {
      return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
