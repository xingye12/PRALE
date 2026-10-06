// Node loader hook that lets the real TypeScript sources load without a build:
//  1. resolves the bare `undici` specifier to the local stub, and
//  2. maps TypeScript's `./x.js` import specifiers onto the real `./x.ts` files.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "undici") {
    return {
      url: new URL("./undici-stub.mjs", import.meta.url).href,
      format: "module",
      shortCircuit: true,
    };
  }
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (specifier.endsWith(".js") && context.parentURL) {
      const rewritten = specifier.replace(/\.js$/, ".ts");
      const candidate = new URL(rewritten, context.parentURL);
      if (existsSync(fileURLToPath(candidate))) return nextResolve(rewritten, context);
    }
    throw err;
  }
}
