/**
 * Minimal Node resolver hook used only by the demo.
 *
 * The repo source uses TypeScript's ESM convention of importing sibling
 * modules with a `.js` specifier (e.g. `./serial-queue.js`). Node's built-in
 * type stripping can execute the `.ts` sources directly, but it does not
 * rewrite `.js` specifiers to `.ts`. This hook maps such a specifier to the
 * sibling `.ts` file when the `.js` file does not exist on disk.
 *
 * No dependency is installed and no repo file is modified.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  if (
    specifier.endsWith(".js") &&
    (specifier.startsWith("./") || specifier.startsWith("../")) &&
    context.parentURL
  ) {
    const candidate = new URL(specifier, context.parentURL);
    const tsCandidate = new URL(candidate.href.replace(/\.js$/, ".ts"));
    if (!existsSync(fileURLToPath(candidate)) && existsSync(fileURLToPath(tsCandidate))) {
      return { url: tsCandidate.href, shortCircuit: true, format: "module-typescript" };
    }
  }
  return nextResolve(specifier, context);
}
