/**
 * Minimal `undici` stand-in for the demo.
 *
 * The v3 SDK statically imports `{ Agent } from "undici"` in
 * `sdk/memory-core/typescript/src/v3/http.ts`. The demo must run with zero
 * installed dependencies, so the loader maps the bare `undici` specifier here.
 *
 * `Agent` is only instantiated when `rejectUnauthorized === false`; the demo
 * talks plain HTTP to a loopback server and never sets that option, so this
 * class is never constructed. It exists purely so the module graph resolves.
 */
export class Agent {
  constructor(opts) {
    this.opts = opts;
  }
  close() {
    return Promise.resolve();
  }
  destroy() {
    return Promise.resolve();
  }
}

export default { Agent };
