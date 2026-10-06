import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL) {
        const base = new URL(specifier, context.parentURL);
        const tsURL = new URL(base.href.replace(/\.js$/, ".ts"));
        if (existsSync(fileURLToPath(tsURL))) {
          return { url: tsURL.href, shortCircuit: true };
        }
      }
      throw err;
    }
  },
});
