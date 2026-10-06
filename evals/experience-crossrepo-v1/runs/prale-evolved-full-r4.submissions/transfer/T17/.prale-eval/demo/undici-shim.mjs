/**
 * Local, dependency-free shim for the `undici` package.
 *
 * The SDK source (`sdk/memory-core/typescript/src/v3/http.ts`) statically
 * imports `{ Agent }` from `undici`. `undici` is a declared dependency of the
 * package but is NOT installed in this checkout (no `node_modules/`), and we
 * must not install dependencies. The contract demo never exercises the
 * `rejectUnauthorized === false` path, so `Agent` is only ever touched as a
 * class reference — a minimal stand-in is enough to let the real source load
 * unmodified.
 */
export class Agent {
  constructor(options) {
    this.options = options;
  }
}
