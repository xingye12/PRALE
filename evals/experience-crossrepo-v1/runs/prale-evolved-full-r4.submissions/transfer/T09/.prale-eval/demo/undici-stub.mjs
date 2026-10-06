// No-op stand-in for the `undici` package. The demo never enables
// `rejectUnauthorized: false`, so `V3HttpTransport` never instantiates `Agent`.
export class Agent {
  constructor(_options) {}
}
