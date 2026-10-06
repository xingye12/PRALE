// Offline shim for the `zod` runtime dependency.
//
// `instance-registry.ts` builds its schemas with zod at module load and uses
// `safeParse` inside `InstanceRegistry.load()`. The demo constructs
// `new InstanceRegistry(entries)` directly (the constructor is public), so the
// schema objects only need to be import-safe and chainable here.
//
// The chain proxy supports any `.object / .array / .string / .min / .url /
// .optional` chain and exposes a permissive `safeParse`.
const chain = new Proxy(function () {}, {
  get(_target, prop) {
    if (prop === 'safeParse') {
      return (value) => ({ success: true, data: value });
    }
    if (prop === 'parse') {
      return (value) => value;
    }
    return chain;
  },
  apply() {
    return chain;
  },
});

export const z = new Proxy(chain, {
  get(_target, prop) {
    if (prop === 'safeParse' || prop === 'parse') {
      return chain[prop];
    }
    return chain;
  },
  apply() {
    return chain;
  },
});

export default z;
