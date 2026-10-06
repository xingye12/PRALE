/**
 * Dependency-free executable demo for the malformed v3 error-envelope fixture.
 *
 * Why this exists: the package's declared devDependencies (vitest) and
 * dependency (undici) are not installed in this checkout, and the task forbids
 * installing them. Node 24 can load the real TypeScript source directly
 * (type stripping), so this script:
 *
 *   1. resolves the bare `undici` import in src/v3/http.ts to a tiny stub
 *      (only the TLS `Agent` is needed, and the demo uses the default path),
 *   2. rewrites the NodeNext `.js` specifiers in the SDK to their `.ts` sources,
 *   3. loads the *real* V3HttpTransport,
 *   4. stubs global `fetch` with the fixture response, and
 *   5. asserts the normalized TDAMError contract.
 *
 * Run: node sdk/memory-core/typescript/tests/run-malformed-envelope-demo.mjs
 */
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

// --- 1/2. Loader hooks: stub `undici` + map `.js` specifiers to `.ts` sources.
const undiciStub = "export class Agent { constructor(options) { this.options = options; } }";
const undiciStubUrl = "data:text/javascript;base64," + Buffer.from(undiciStub).toString("base64");

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "undici") return { url: undiciStubUrl, shortCircuit: true };
    try {
      return nextResolve(specifier, context);
    } catch (err) {
      if (specifier.endsWith(".js") && context.parentURL) {
        const candidate = new URL(
          specifier.replace(/\.js$/, ".ts"),
          new URL(".", context.parentURL),
        );
        if (existsSync(fileURLToPath(candidate))) {
          return { url: candidate.href, shortCircuit: true };
        }
      }
      throw err;
    }
  },
});

// --- 3. Load the real transport + error type from source.
const { V3HttpTransport } = await import("../src/v3/http.ts");
const { TDAMError } = await import("../src/errors.ts");

// --- Fixture under test.
const fixturePath = fileURLToPath(new URL("./fixtures/malformed-error-envelope.json", import.meta.url));
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

// --- 4. Stub global fetch with the malformed error response.
let capturedUrl = "";
globalThis.fetch = async (url) => {
  capturedUrl = String(url);
  return new Response(fixture.body, {
    status: fixture.http.status,
    statusText: fixture.http.statusText,
    headers: fixture.http.headers,
  });
};

const transport = new V3HttpTransport({
  endpoint: "http://127.0.0.1:9",
  apiKey: "sk-test",
  serviceId: "svc-test",
});

// --- 5. Assert the normalized contract.
let thrown;
try {
  await transport.post("/v3/conversation/add", {});
} catch (err) {
  thrown = err;
}

assert.ok(thrown instanceof TDAMError, "expected the transport to throw a TDAMError");
assert.equal(thrown.name, fixture.expected_error.name, "name");
assert.equal(thrown.code, fixture.expected_error.code, "code falls back to HTTP status");
assert.equal(thrown.message, fixture.expected_error.message, "message falls back to `HTTP <status>`");
assert.equal(thrown.requestId, fixture.expected_error.requestId, "request id recovered from header");
assert.equal(thrown.details, undefined, "primitive `data` yields no details");
assert.match(capturedUrl, /\/v3\/conversation\/add$/, "request hit the /v3 path");

console.log("PASS malformed-error-envelope");
console.log(`  fixture : ${fixturePath}`);
console.log(`  request : POST ${capturedUrl}`);
console.log(`  thrown  : ${thrown.name} code=${thrown.code} message=${JSON.stringify(thrown.message)}`);
