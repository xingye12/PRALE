// Module-resolution hook for offline execution of the MemoryPanel precedence
// test/demo:
//   * the uninstalled runtime deps (`dotenv`, `zod`, `vitest`) resolve to the
//     import-safe shims in .prale-eval/shims/;
//   * the repo's NodeNext `.js` import specifiers resolve to the sibling `.ts`
//     source when no compiled `.js` exists (the same mapping tsx/vitest apply).
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SHIMS = new URL('./shims/', import.meta.url);
const SHIMMED = new Set(['dotenv', 'zod', 'vitest']);

export async function resolve(specifier, context, next) {
  if (SHIMMED.has(specifier)) {
    return { url: new URL(`${specifier}.mjs`, SHIMS).href, shortCircuit: true };
  }
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
    const url = new URL(specifier, context.parentURL);
    if (!existsSync(fileURLToPath(url))) {
      const tsUrl = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
      if (existsSync(fileURLToPath(tsUrl))) {
        return { url: tsUrl.href, shortCircuit: true };
      }
    }
  }
  return next(specifier, context);
}
