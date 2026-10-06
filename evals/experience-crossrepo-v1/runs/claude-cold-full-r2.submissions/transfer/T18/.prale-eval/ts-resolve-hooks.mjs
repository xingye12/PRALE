// ESM resolve hook: allow the repository's `.js`-suffixed relative imports
// (TypeScript NodeNext convention) to resolve to the sibling `.ts` source so
// Node's native type-stripping can execute the real, unmodified sources.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (specifier.endsWith(".js") && context.parentURL) {
      const url = new URL(specifier, context.parentURL);
      const tsUrl = url.href.replace(/\.js$/, ".ts");
      if (existsSync(fileURLToPath(tsUrl))) {
        return { url: tsUrl, shortCircuit: true };
      }
    }
    throw err;
  }
}
