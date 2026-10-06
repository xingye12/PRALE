// Minimal stand-in for the `undici` bare specifier, which is not installed in
// this evaluation workspace. The contract only exercises the JSON-envelope
// normalization path; `Agent` is never constructed unless rejectUnauthorized
// is explicitly false, so this stub does not alter the behaviour under test.
export class Agent {
  constructor(_options) {}
  close() {}
}
