// Node module resolution hooks that let the demo run the real
// packages/coding-agent sources in an offline checkout (no node_modules).
//
// Every bare (npm) specifier is mapped to a deterministic in-memory stub. A few
// packages that the exercised code paths really call into get small faithful
// implementations (chalk/ignore/minimatch/semver/proper-lockfile/jiti). Node
// builtins and all relative imports are resolved normally, so the demo still
// executes the repository's own code.
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";

const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

const exportTable = JSON.parse(readFileSync(new URL("./stub-exports.json", import.meta.url), "utf-8"));
const overrides = JSON.parse(readFileSync(new URL("./stub-overrides.json", import.meta.url), "utf-8"));

const STUB_PREFIX = "stub:";

const genericSource = `
const generic = (() => {
  const fn = function () { return proxy; };
  const proxy = new Proxy(fn, {
    get(target, prop) {
      if (prop === "then") return undefined;
      if (prop === Symbol.toPrimitive) return () => 0;
      if (prop === Symbol.iterator) return function* () {};
      if (prop === Symbol.asyncIterator) return function () { return { next: async () => ({ done: true, value: undefined }) }; };
      if (prop === "toString") return () => "";
      if (prop === "valueOf") return () => 0;
      if (prop === "length") return 0;
      if (prop === "name") return "stub";
      if (prop === "prototype") return target.prototype;
      if (prop === "__esModule") return true;
      return proxy;
    },
    apply() { return proxy; },
    construct() { return proxy; },
    has() { return true; },
  });
  return proxy;
})();
`;

function stubModuleSource(specifier) {
  const override = overrides[specifier];
  if (override?.source) return override.source;
  const names = (exportTable[specifier] ?? []).filter((n) => !n.startsWith("__"));
  const lines = [genericSource];
  for (const name of names) {
    lines.push(`export const ${name} = ${override?.[name] !== undefined ? JSON.stringify(override[name]) : "generic"};`);
  }
  lines.push(override?.defaultSource ?? "export default generic;");
  if (override?.extra) lines.push(override.extra);
  return lines.join("\n");
}

export async function resolve(specifier, context, nextResolve) {
  // Shim the heavy `index.ts` (and the virtual module table) pulled in by
  // extensions/loader.ts; the demo does not need bundled extension virtuals.
  if (specifier === "./virtual-modules.ts" && context.parentURL?.endsWith("/core/extensions/loader.ts")) {
    return { url: `${STUB_PREFIX}virtual-modules`, shortCircuit: true, format: "module" };
  }
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("file:") ||
    specifier.startsWith("data:") ||
    specifier.startsWith("node:") ||
    builtins.has(specifier)
  ) {
    return nextResolve(specifier, context);
  }
  return { url: `${STUB_PREFIX}${specifier}`, shortCircuit: true, format: "module" };
}

export async function load(url, context, nextLoad) {
  if (url.startsWith(STUB_PREFIX)) {
    const specifier = url.slice(STUB_PREFIX.length);
    if (specifier === "virtual-modules") {
      return { format: "module", shortCircuit: true, source: "export const VIRTUAL_MODULES = {};\n" };
    }
    return { format: "module", shortCircuit: true, source: stubModuleSource(specifier) };
  }
  return nextLoad(url, context);
}
