// Minimal stand-in for the `undici` package so the real v3 transport can be
// imported without an npm install. The contract under test only uses the
// `Agent` constructor when `rejectUnauthorized === false`; the `dispatcher`
// object is never dereferenced by `fetch` in the mocked-response tests.
export class Agent {
  constructor(options) {
    this.options = options;
  }
}

export default { Agent };
