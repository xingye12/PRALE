/**
 * Executable contract check for the v3 SDK HTTP/error path.
 *
 * Drives the REAL `V3HttpTransport` (src/v3/http.ts) against every malformed
 * error envelope in tests/fixtures/v3/malformed-error-envelope.json and
 * asserts each one is normalized to a thrown `TDAMError` — never an uncaught
 * `TypeError` from property access on a non-object body.
 *
 * Run without installing dependencies:
 *   node tests/v3/run-malformed-envelope.mjs
 */
import { readFileSync } from "node:fs";
import { register } from "node:module";

register(new URL("./undici-stub-hooks.mjs", import.meta.url));

const fixtureUrl = new URL("../fixtures/v3/malformed-error-envelope.json", import.meta.url);
const fixture = JSON.parse(readFileSync(fixtureUrl, "utf8"));

const { V3HttpTransport } = await import("../../src/v3/http.ts");
const { TDAMError } = await import("../../src/errors.ts");

function makeResponse(c) {
  return new Response(c.body, { status: c.status, headers: c.headers });
}

function describeValue(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (v instanceof Error) return `${v.constructor.name}: ${v.message}`;
  return `${typeof v}`;
}

async function runCase(c) {
  globalThis.fetch = async () => makeResponse(c);
  const transport = new V3HttpTransport({
    endpoint: "http://memory-gateway.test",
    apiKey: "test-key",
    serviceId: "svc-test",
  });
  try {
    const data = await transport.post(fixture.request.path, fixture.request.body);
    return { thrown: undefined, data };
  } catch (err) {
    return { thrown: err, data: undefined };
  }
}

let failures = 0;
const rows = [];

for (const c of fixture.cases) {
  const { thrown } = await runCase(c);
  const problems = [];
  if (!thrown) {
    problems.push("expected a thrown error, got a resolved value");
  } else if (!(thrown instanceof TDAMError)) {
    problems.push(`expected TDAMError, got ${describeValue(thrown)}`);
  } else {
    // `expect.message` is the raw server/normalized message; TDAMError wraps it
    // as `[code] message (request_id=requestId)` (see src/errors.ts).
    const expectedMessage = `[${c.expect.code}] ${c.expect.message} (request_id=${c.expect.requestId})`;
    if (thrown.name !== c.expect.name) problems.push(`name=${thrown.name} != ${c.expect.name}`);
    if (thrown.code !== c.expect.code) problems.push(`code=${thrown.code} != ${c.expect.code}`);
    if (thrown.message !== expectedMessage) {
      problems.push(`message=${JSON.stringify(thrown.message)} != ${JSON.stringify(expectedMessage)}`);
    }
    if (thrown.requestId !== c.expect.requestId) {
      problems.push(`requestId=${JSON.stringify(thrown.requestId)} != ${JSON.stringify(c.expect.requestId)}`);
    }
  }
  if (problems.length) failures++;
  rows.push({ case: c.name, status: problems.length ? "FAIL" : "ok", detail: problems.join("; ") });
}

// Control: a well-formed success envelope must still unwrap to `data` unchanged.
globalThis.fetch = async () =>
  new Response(JSON.stringify({ code: 0, message: "ok", request_id: "r-1", data: { hit: 1 } }), {
    status: 200,
    headers: { "content-type": "application/json", "x-trace-id": "trace-ok" },
  });
const okTransport = new V3HttpTransport({
  endpoint: "http://memory-gateway.test",
  apiKey: "test-key",
  serviceId: "svc-test",
});
const okData = await okTransport.post(fixture.request.path, fixture.request.body);
const controlOk = okData && okData.hit === 1 && okData.trace_id === "trace-ok";
if (!controlOk) failures++;
rows.push({ case: "control:well_formed_success", status: controlOk ? "ok" : "FAIL", detail: JSON.stringify(okData) });

for (const r of rows) {
  console.log(`${r.status.padEnd(5)} ${r.case}${r.detail ? `  -- ${r.detail}` : ""}`);
}
console.log(
  `\n${fixture.cases.length} malformed-envelope case(s) + 1 control; ${failures} failure(s).`,
);
process.exit(failures === 0 ? 0 : 1);
