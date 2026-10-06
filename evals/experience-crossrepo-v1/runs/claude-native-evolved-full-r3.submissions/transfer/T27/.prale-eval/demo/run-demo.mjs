/**
 * Executable demo: one write then one scoped read against a local fake HTTP
 * backend, driven by the real v3 SDK (`sdk/memory-core/typescript/src/v3/client.ts`)
 * over the real `V3HttpTransport`.
 *
 * Run (zero installed dependencies — Node's built-in TS support is used):
 *
 *   node --experimental-transform-types \
 *        --import ./.prale-eval/demo/register.mjs \
 *        ./.prale-eval/demo/run-demo.mjs
 *
 * What is verified:
 *   1. request order      — the write POST lands before the read POST
 *   2. scope metadata     — team/agent/user(/task) isolation triple is carried
 *                           on every body, and a narrowed scope drops task_id
 *   3. normalized result  — the {code,message,request_id,data} envelope is
 *                           unwrapped to `data`, and `x-trace-id` is merged in
 *
 * Exit code 0 = all checks pass, 1 = at least one check failed.
 */
import http from "node:http";
import assert from "node:assert/strict";

// Resolved through ./.prale-eval/demo/loader.mjs (undici shim + .js -> .ts).
import { MemoryClient } from "../../sdk/memory-core/typescript/src/v3/client.ts";

const WRITE_PATH = "/v3/scenario/write";
const READ_PATH = "/v3/scenario/read";

const SCOPE = {
  teamId: "team-alpha",
  agentId: "agent-alpha",
  userId: "user-alpha",
  sessionId: "sess-alpha",
  taskId: "task-alpha",
};

const NOTE_PATH = "notes/cross-repo-transfer.md";
const NOTE_BODY = "# Cross-repo transfer\n\ntdma demo note\n";
const NOTE_SUMMARY = "demo note";

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, ok: true });
  } catch (err) {
    checks.push({ name, ok: false, detail: String(err.message).split("\n")[0] });
  }
}
function deepEqual(actual, expected, label) {
  try {
    assert.deepEqual(actual, expected);
  } catch {
    throw new Error(`${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
}

// --- local fake HTTP backend ------------------------------------------------
/** Request log, in arrival order. */
const requests = [];
/** Server-side file store for the L2 scenario path. */
const files = new Map();

function envelope(data, traceId, code = 0, message = "ok") {
  return JSON.stringify({ code, message, request_id: `srv-${requests.length}`, data });
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("end", () => {
    let body = {};
    const raw = Buffer.concat(chunks).toString("utf8");
    if (raw) body = JSON.parse(raw);
    requests.push({
      seq: requests.length,
      method: req.method,
      path: new URL(req.url, "http://localhost").pathname,
      headers: req.headers,
      body,
    });

    // Server-side scope enforcement: the isolation triple is mandatory. A
    // request missing it is rejected, so a passing demo proves the SDK
    // actually emitted the scope rather than the test assuming it.
    const missing = ["team_id", "agent_id", "user_id"].filter((k) => !body[k]);
    if (missing.length) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(envelope({ missing }, "trace-reject", 40001, "missing isolation fields"));
      return;
    }

    const path = new URL(req.url, "http://localhost").pathname;
    if (path === WRITE_PATH) {
      files.set(body.path, { content: body.content, updated_at: "2026-10-03T00:00:00.000Z" });
      res.writeHead(200, { "content-type": "application/json", "x-trace-id": "trace-write-1" });
      res.end(
        envelope(
          { path: body.path, updated_at: files.get(body.path).updated_at },
          "trace-write-1",
        ),
      );
      return;
    }
    if (path === READ_PATH) {
      const hit = files.get(body.path) ?? { content: null, updated_at: null };
      res.writeHead(200, { "content-type": "application/json", "x-trace-id": "trace-read-1" });
      res.end(
        envelope(
          {
            path: body.path,
            content: hit.content,
            created_at: "2026-10-03T00:00:00.000Z",
            updated_at: hit.updated_at,
          },
          "trace-read-1",
        ),
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(envelope(null, "trace-404", 404, "unknown route"));
  });
  req.on("data", (c) => chunks.push(c));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const endpoint = `http://127.0.0.1:${port}`;

// --- SDK client -------------------------------------------------------------
// Real transport: V3HttpTransport builds `endpoint + path`, POSTs JSON with the
// Authorization / x-tdai-service-id headers, and normalizes the envelope.
const client = new MemoryClient({
  endpoint,
  apiKey: "demo-api-key",
  serviceId: "demo-service",
  ...SCOPE,
});

let writeResult;
let readResult;
let readBody;

try {
  // 1) WRITE — strict isolation scope, session required for write paths.
  writeResult = await client.writeScenario({
    path: NOTE_PATH,
    content: NOTE_BODY,
    summary: NOTE_SUMMARY,
  });

  // 2) SCOPED READ — same endpoint/transport, scope narrowed by clearing taskId.
  //    `withIsolation` returns a new client sharing the transport; the cleared
  //    task_id must not appear in the outgoing body at all.
  const scoped = client.withIsolation({ taskId: null });
  readResult = await scoped.readScenario({ path: NOTE_PATH });
} finally {
  server.close();
}

const [writeReq, readReq] = requests;
readBody = readReq.body;

// --- verification -----------------------------------------------------------
check("request order: exactly one write then one scoped read", () => {
  deepEqual(
    requests.map((r) => `${r.method} ${r.path}`),
    [`POST ${WRITE_PATH}`, `POST ${READ_PATH}`],
    "request sequence",
  );
});

check("scope metadata: write carries the full isolation triple + task", () => {
  deepEqual(
    {
      team_id: writeReq.body.team_id,
      agent_id: writeReq.body.agent_id,
      user_id: writeReq.body.user_id,
      task_id: writeReq.body.task_id,
    },
    {
      team_id: SCOPE.teamId,
      agent_id: SCOPE.agentId,
      user_id: SCOPE.userId,
      task_id: SCOPE.taskId,
    },
    "write scope",
  );
  deepEqual(
    { path: writeReq.body.path, content: writeReq.body.content, summary: writeReq.body.summary },
    { path: NOTE_PATH, content: NOTE_BODY, summary: NOTE_SUMMARY },
    "write payload",
  );
});

check("scope metadata: scoped read keeps triple and drops task_id", () => {
  deepEqual(
    {
      team_id: readBody.team_id,
      agent_id: readBody.agent_id,
      user_id: readBody.user_id,
    },
    { team_id: SCOPE.teamId, agent_id: SCOPE.agentId, user_id: SCOPE.userId },
    "read scope",
  );
  check("read body omits cleared task_id and any undefined key", () => {
    if ("task_id" in readBody) throw new Error("task_id leaked into narrowed scope");
    if ("session_id" in readBody) throw new Error("session_id leaked into scenario read");
    const undefinedKeys = Object.entries(readBody).filter(([, v]) => v === undefined).map(([k]) => k);
    if (undefinedKeys.length) throw new Error(`undefined-valued keys: ${undefinedKeys.join(",")}`);
  });
  deepEqual(readBody.path, NOTE_PATH, "read path");
});

check("normalized result: write envelope unwrapped + trace id merged", () => {
  deepEqual(writeResult, {
    path: NOTE_PATH,
    updated_at: "2026-10-03T00:00:00.000Z",
    trace_id: "trace-write-1",
  });
  for (const k of ["code", "message", "request_id", "data"]) {
    if (k in writeResult) throw new Error(`envelope field "${k}" leaked into result`);
  }
});

check("normalized result: scoped read envelope unwrapped + content round-trips", () => {
  deepEqual(readResult, {
    path: NOTE_PATH,
    content: NOTE_BODY,
    created_at: "2026-10-03T00:00:00.000Z",
    updated_at: "2026-10-03T00:00:00.000Z",
    trace_id: "trace-read-1",
  });
  for (const k of ["code", "message", "request_id", "data"]) {
    if (k in readResult) throw new Error(`envelope field "${k}" leaked into result`);
  }
});

check("transport metadata: auth headers on both requests", () => {
  for (const r of requests) {
    if (r.headers.authorization !== "Bearer demo-api-key") throw new Error(`${r.path}: bad auth header`);
    if (r.headers["x-tdai-service-id"] !== "demo-service") throw new Error(`${r.path}: bad service header`);
  }
});

// --- report -----------------------------------------------------------------
const failed = checks.filter((c) => !c.ok);
const report = {
  demo: "tdma write-then-scoped-read",
  endpoint,
  request_order: requests.map((r) => `${r.method} ${r.path}`),
  write_body: writeReq.body,
  read_body: readBody,
  write_result: writeResult,
  read_result: readResult,
  checks,
  status: failed.length ? "FAIL" : "PASS",
};
console.log(JSON.stringify(report, null, 2));
if (failed.length) {
  console.error(`\n${failed.length} check(s) failed`);
  process.exit(1);
}
console.log(`\nall ${checks.length} checks passed`);
