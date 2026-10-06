/**
 * T09 (tdam, demo): one write then one scoped read against a local fake HTTP
 * backend, verifying (a) request order, (b) scope metadata, (c) normalized
 * result.
 *
 * The demo drives the repository's real v3 data-plane client
 * (`sdk/memory-core/typescript/src/v3/client.ts` ->
 * `MemoryClient.writeScenario` / `MemoryClient.readScenario`) through its real
 * `V3HttpTransport`. The only thing faked is the network peer: a `node:http`
 * server bound to 127.0.0.1 on an ephemeral port that speaks the SDK's
 * `/v3/*` envelope contract (`{ code, message, request_id, data }` +
 * `x-trace-id` response header).
 *
 * Run:
 *   node --experimental-transform-types .prale-eval/demo/run-demo.mjs
 *
 * Zero external dependencies. `--experimental-transform-types` is required
 * because the SDK sources use TypeScript parameter properties, which Node's
 * strip-only mode rejects.
 */
import http from "node:http";
import { once } from "node:events";
import { register } from "node:module";

// Teach Node how to resolve the SDK's bundler-style imports (see loader.mjs).
register("./loader.mjs", import.meta.url);

const { MemoryClient } = await import(
  "../../sdk/memory-core/typescript/src/v3/client.ts"
);
const { TDAMError } = await import(
  "../../sdk/memory-core/typescript/src/errors.ts"
);

// ---------------------------------------------------------------------------
// Local fake HTTP backend
// ---------------------------------------------------------------------------

const SCOPE = { team_id: "team-demo", agent_id: "agt-demo", user_id: "usr-demo" };
const WRITE_PATH = "notes/demo.md";
const WRITTEN = "hello from the write";

/** @type {Array<{seq:number,path:string,body:any,auth:string,service:string,startedAt:number,completedAt:number}>} */
const requests = [];
let seq = 0;
const store = new Map();
const keyOf = (b) => `${b.team_id}/${b.agent_id}/${b.user_id}/${b.path}`;

function envelope(code, data, message = "ok") {
  return { code, message, request_id: `req-${seq}`, data };
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    seq += 1;
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : {};
    const entry = {
      seq,
      path: req.url,
      body,
      auth: req.headers["authorization"] ?? "",
      service: req.headers["x-tdai-service-id"] ?? "",
      startedAt: Date.now(),
      completedAt: 0,
    };
    requests.push(entry);

    let status = 200;
    let payload;
    if (req.method !== "POST") {
      status = 405;
      payload = envelope(405, undefined, "method not allowed");
    } else if (req.url === "/v3/scenario/write") {
      const now = new Date().toISOString();
      store.set(keyOf(body), { content: body.content, summary: body.summary, updated_at: now });
      payload = envelope(0, { path: body.path, updated_at: now });
    } else if (req.url === "/v3/scenario/read") {
      if (body.path === "__error__") {
        payload = envelope(5001, { path: body.path }, "scenario not readable");
      } else {
        const hit = store.get(keyOf(body));
        payload = envelope(0, {
          path: body.path,
          content: hit ? hit.content : null,
          created_at: hit ? hit.updated_at : null,
          updated_at: hit ? hit.updated_at : null,
        });
      }
    } else {
      status = 404;
      payload = envelope(404, undefined, "unknown route");
    }

    const text = JSON.stringify(payload);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "x-trace-id": `trace-${seq}`,
    });
    res.end(text);
    entry.completedAt = Date.now();
  });
});

server.listen(0, "127.0.0.1");
await once(server, "listening");
const { port } = server.address();
const endpoint = `http://127.0.0.1:${port}`;

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
}

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

async function main() {
  const client = new MemoryClient({
    endpoint,
    apiKey: "demo-bearer-token",
    serviceId: "memory-demo-1",
    teamId: SCOPE.team_id,
    agentId: SCOPE.agent_id,
    userId: SCOPE.user_id,
    sessionId: "sess-demo", // L2/L3 ignore session scope; asserted below
    rejectUnauthorized: true,
  });

  // (1) WRITE
  const writeResult = await client.writeScenario({
    path: WRITE_PATH,
    content: WRITTEN,
    summary: "demo note",
  });
  // (2) SCOPED READ (same isolation scope, same path)
  const readResult = await client.readScenario({ path: WRITE_PATH });

  // --- (a) request order -------------------------------------------------
  const ordered = requests.filter((r) => r.path !== null);
  check(
    "request order: write then read",
    requests.length === 2 &&
      requests[0].path === "/v3/scenario/write" &&
      requests[1].path === "/v3/scenario/read",
    requests.map((r) => r.path),
  );
  check(
    "read was not sent until write response completed",
    requests[0].completedAt <= requests[1].startedAt,
    { writeCompletedAt: requests[0].completedAt, readStartedAt: requests[1].startedAt },
  );
  void ordered;

  const writeReq = requests[0].body;
  const readReq = requests[1].body;

  // --- (b) scope metadata ------------------------------------------------
  const scopeOk = (b) =>
    b.team_id === SCOPE.team_id &&
    b.agent_id === SCOPE.agent_id &&
    b.user_id === SCOPE.user_id;
  check("write carries isolation scope metadata", scopeOk(writeReq), writeReq);
  check("read carries the same isolation scope metadata", scopeOk(readReq), readReq);
  check(
    "L2 requests do not leak the optional session scope",
    !has(writeReq, "session_id") && !has(readReq, "session_id"),
    { write: has(writeReq, "session_id"), read: has(readReq, "session_id") },
  );
  check(
    "write payload is scope + document fields",
    eq(Object.keys(writeReq).sort(), ["agent_id", "content", "path", "summary", "team_id", "user_id"]),
    Object.keys(writeReq).sort(),
  );
  check(
    "read payload is a scoped single-path lookup (no write fields)",
    eq(Object.keys(readReq).sort(), ["agent_id", "path", "team_id", "user_id"]),
    Object.keys(readReq).sort(),
  );

  // --- (c) normalized result --------------------------------------------
  check(
    "write result is the unwrapped `data` (no envelope fields) + trace_id",
    writeResult.path === WRITE_PATH &&
      typeof writeResult.updated_at === "string" &&
      !has(writeResult, "code") &&
      !has(writeResult, "message") &&
      !has(writeResult, "request_id"),
    writeResult,
  );
  check(
    "read result is the unwrapped normalized ScenarioFile",
    eq(
      { path: readResult.path, content: readResult.content },
      { path: WRITE_PATH, content: WRITTEN },
    ),
    readResult,
  );
  check("trace_id propagated from response header", readResult.trace_id === "trace-2", readResult.trace_id);

  // Normalization of a missing document: content null, timestamps null.
  const missing = await client.readScenario({ path: "notes/missing.md" });
  check(
    "missing document normalizes to nulls",
    missing.content === null && missing.created_at === null && missing.updated_at === null,
    missing,
  );

  // Normalization of a non-zero business code: throw TDAMError, not a raw body.
  let thrown;
  try {
    await client.readScenario({ path: "__error__" });
  } catch (e) {
    thrown = e;
  }
  check(
    "non-zero envelope code throws normalized TDAMError",
    thrown instanceof TDAMError &&
      thrown.code === 5001 &&
      // request id comes from the response header (x-trace-id / x-qcloud-
      // transaction-id), which takes precedence over the envelope's request_id.
      thrown.requestId === "trace-4",
    thrown ? { name: thrown.name, code: thrown.code, requestId: thrown.requestId, message: thrown.message } : thrown,
  );

  // --- wire-level auth contract -----------------------------------------
  const authOk = requests.every(
    (r) => r.auth === "Bearer demo-bearer-token" && r.service === "memory-demo-1",
  );
  check("every request carries auth + service headers", authOk, requests.map((r) => ({ auth: r.auth, service: r.service })));

  return { writeResult, readResult, missing, errorCode: thrown?.code ?? null };
}

const summary = await main();
server.close();
await once(server, "close");

const failed = results.filter((r) => !r.ok);
console.log("\n=== T09 tdam demo: write -> scoped read over fake HTTP backend ===");
for (const r of results) {
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
  if (!r.ok) console.log(`      detail: ${JSON.stringify(r.detail)}`);
}
console.log("\n--- observed request sequence ---");
for (const r of requests) {
  console.log(`${r.seq}. POST ${r.path}  body=${JSON.stringify(r.body)}`);
}
console.log("\n--- normalized results ---");
console.log("write:", JSON.stringify(summary.writeResult));
console.log("read :", JSON.stringify(summary.readResult));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) process.exitCode = 1;
