/**
 * Stub for the `undici` package, which is a real dependency of the SDK but is
 * not installed in this offline checkout. `HttpTransport` only reaches for
 * `Agent` when `rejectUnauthorized !== true`; the demo passes
 * `rejectUnauthorized: true`, so no real TLS agent is constructed.
 */

export class Agent {
  constructor(_options) {
    this.options = _options;
  }
}

export default { Agent };
