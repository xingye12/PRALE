// Module resolve hook: Node's built-in TS type-stripping parses `.ts` sources
// but does NOT rewrite ESM specifiers like `./serial-queue.js` back to `.ts`.
// This hook lets the validation harness import the repository's real TS sources
// unmodified (no dependencies, no build step, no copy of the code under test).
import { existsSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  if (
    specifier.endsWith(".js") &&
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    context.parentURL?.startsWith("file:")
  ) {
    const candidate = resolvePath(
      dirname(fileURLToPath(context.parentURL)),
      specifier.slice(0, -3) + ".ts",
    );
    if (existsSync(candidate)) {
      return { url: pathToFileURL(candidate).href, shortCircuit: true };
    }
  }
  return nextResolve(specifier, context);
}
