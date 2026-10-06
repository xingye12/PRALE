/**
 * Minimal, dependency-free resolver hook so Node 24 can run the repository's
 * TypeScript directly (native type stripping) even though the source files use
 * ESM-style `./foo.js` specifiers that must resolve to the on-disk `./foo.ts`.
 *
 * No dependencies are installed in this workspace, so this hook is the only
 * mechanism needed to exercise the REAL MemoryKnowledge sources at runtime.
 */
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
        const candidate = new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL);
        if (existsSync(fileURLToPath(candidate))) {
          return { url: candidate.href, shortCircuit: true };
        }
      }
      throw err;
    }
  },
});
