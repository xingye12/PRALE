/**
 * Stand-in for the `undici` runtime dependency of the TypeScript SDK.
 *
 * Only `Agent` is imported by `sdk/memory-core/typescript/src/v3/http.ts`, and
 * only when `rejectUnauthorized: false` is configured. The demo points the SDK
 * at a plain-HTTP localhost backend and leaves TLS verification at its default,
 * so this stub is never instantiated; it merely satisfies the static import so
 * the real SDK sources can be loaded without installing dependencies.
 */
export class Agent {
  constructor(options = {}) {
    this.options = options;
  }

  close() {
    return Promise.resolve();
  }

  destroy() {
    return Promise.resolve();
  }
}

export default { Agent };
