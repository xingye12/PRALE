#!/usr/bin/env node
/**
 * T27 demo — one write, then one scoped read, against a local fake HTTP backend.
 *
 * This runs the REAL SDK code, not a re-implementation:
 *   - `MemoryClient`      (src/v3/client.ts)   — isolation context + method bodies
 *   - `V3HttpTransport`   (src/v3/http.ts)     — headers, envelope unwrapping
 * against a fake backend served by `node:http` on 127.0.0.1. Node's global
 * `fetch` performs the real HTTP round trips.
 *
 * What it verifies:
 *   1. request order      — POST /v3/conversation/add strictly before
 *                           POST /v3/conversation/query
 *   2. scope metadata     — auth/service headers plus the isolation triple
 *                           (team_id/agent_id/user_id/session_id) inside the
 *                           JSON body, with undefined fields stripped
 *   3. normalized result  — the envelope `{code,message,request_id,data}` is
 *                           unwrapped to `data`, and the `x-trace-id` response
 *                           header is attached as `trace_id`
 *   4. scope override     — `withIsolation()` re-scopes a later read
 *
 * Run from `sdk/memory-core/typescript`:
 *   node --experimental-transform-types demo/fake-backend-demo.mjs
 *
 * `--experimental-transform-types` is required because `v3/client.ts` uses a
 * TypeScript parameter property, which Node's strip-only mode rejects. No
 * dependencies are installed: `demo/loader.mjs` maps `undici` to a stub and
 * resolves the SDK's `.js` specifiers onto its `.ts` sources.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { register } from "node:module";

register("./loader.mjs", import.meta.url);

const { MemoryClient } = await import("../src/v3/client.ts");

const API_KEY = "demo-api-key";
const SERVICE_ID = "svc-demo-0001";

// ---------------------------------------------------------------------------
// Local fake HTTP backend
// ---------------------------------------------------------------------------

/** Every request the SDK sends, in arrival order. */
const requestLog = [];

function startFakeBackend() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString("utf8");
      const entry = {
        seq: requestLog.length + 1,
        method: req.method,
        path: req.url,
        headers: req.headers,
        body: raw ? JSON.parse(raw) : {},
      };
      requestLog.push(entry);

      const send = (data, requestId, traceId) => {
        res.writeHead(200, {
          "content-type": "application/json",
          "x-qcloud-transaction-id": requestId,
          "x-trace-id": traceId,
        });
        res.end(JSON.stringify({ code: 0, message: "ok", request_id: requestId, data }));
      };

      if (entry.path === "/v3/conversation/add") {
        send({ accepted_ids: ["msg-1001"], total_count: 1 }, "req-write-1", "trace-write-1");
      } else if (entry.path === "/v3/conversation/query") {
        send(
          {
            messages: [
              {
                id: "msg-1001",
                role: "user",
                content: "remember: T27 demo",
                timestamp: "2026-10-03T00:00:00Z",
              },
            ],
            total: 1,
          },
          "req-read-1",
          "trace-read-1",
        );
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            code: 40400,
            message: `fake backend has no handler for ${entry.path}`,
            request_id: "req-miss",
          }),
        );
      }
    });

    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: server.address().port });
    });
  });
}

// ---------------------------------------------------------------------------
// Assertion harness
// ---------------------------------------------------------------------------

const results = [];
function check(label, fn) {
  try {
    fn();
    results.push({ label, ok: true, detail: "" });
  } catch (err) {
    results.push({ label, ok: false, detail: err.message });
  }
}

// ---------------------------------------------------------------------------
// Demo body
// ---------------------------------------------------------------------------

const { server, port } = await startFakeBackend();
const endpoint = `http://127.0.0.1:${port}`;

try {
  const client = new MemoryClient({
    endpoint,
    apiKey: API_KEY,
    serviceId: SERVICE_ID,
    teamId: "team-alpha",
    agentId: "agent-qa",
    userId: "user-42",
    sessionId: "session-2026-10-03",
    // `taskId` intentionally omitted: it must be stripped from the request body
    // rather than sent as null/undefined.
  });

  // -- Step 1: the write -----------------------------------------------------
  const writeResult = await client.addConversation({
    messages: [{ role: "user", content: "remember: T27 demo" }],
  });

  // -- Step 2: the scoped read ----------------------------------------------
  const readResult = await client.queryConversation({ limit: 10 });

  // -- Step 3: scoped read under narrowed isolation --------------------------
  const narrowed = client.withIsolation({ userId: "user-77", sessionId: null });
  const narrowedResult = await narrowed.queryConversation({ limit: 10 });

  const [writeReq, readReq, narrowedReq] = requestLog;

  console.log("fake backend request log");
  for (const req of requestLog) {
    console.log(`  #${req.seq} ${req.method} ${req.path} body=${JSON.stringify(req.body)}`);
  }
  console.log();

  // 1. request order
  check("write precedes read (2 requests for steps 1-2, in order)", () => {
    assert.equal(requestLog.length, 3, "expected exactly three requests");
    assert.equal(writeReq.path, "/v3/conversation/add");
    assert.equal(readReq.path, "/v3/conversation/query");
    assert.equal(writeReq.method, "POST");
    assert.equal(readReq.method, "POST");
    assert.ok(writeReq.seq < readReq.seq, "write must be recorded before read");
  });

  // 2. scope metadata — transport headers
  check("transport headers carry bearer token + service id", () => {
    for (const req of requestLog) {
      assert.equal(req.headers["authorization"], `Bearer ${API_KEY}`);
      assert.equal(req.headers["x-tdai-service-id"], SERVICE_ID);
      assert.equal(req.headers["content-type"], "application/json");
    }
  });

  // 2. scope metadata — isolation triple in the body
  check("write body carries the full isolation scope", () => {
    assert.deepEqual(writeReq.body, {
      team_id: "team-alpha",
      agent_id: "agent-qa",
      user_id: "user-42",
      session_id: "session-2026-10-03",
      messages: [{ role: "user", content: "remember: T27 demo" }],
    });
    assert.ok(!("task_id" in writeReq.body), "undefined task_id must be stripped");
  });

  check("read body is scoped by the same isolation, plus its own params", () => {
    assert.deepEqual(readReq.body, {
      team_id: "team-alpha",
      agent_id: "agent-qa",
      user_id: "user-42",
      session_id: "session-2026-10-03",
      limit: 10,
    });
  });

  check("withIsolation re-scopes the read body", () => {
    assert.equal(narrowedReq.body.user_id, "user-77");
    assert.ok(!("session_id" in narrowedReq.body), "sessionId:null must drop session_id");
    assert.equal(narrowedReq.body.team_id, "team-alpha", "untouched scope fields carry over");
  });

  // 3. normalized result
  check("write result is the unwrapped envelope data (+ trace_id)", () => {
    assert.deepEqual(writeResult, {
      accepted_ids: ["msg-1001"],
      total_count: 1,
      trace_id: "trace-write-1",
    });
    assert.ok(!("code" in writeResult) && !("data" in writeResult), "envelope must not leak");
  });

  check("read result is the unwrapped envelope data (+ trace_id)", () => {
    assert.deepEqual(readResult, {
      messages: [
        {
          id: "msg-1001",
          role: "user",
          content: "remember: T27 demo",
          timestamp: "2026-10-03T00:00:00Z",
        },
      ],
      total: 1,
      trace_id: "trace-read-1",
    });
    assert.ok(!("code" in readResult) && !("message" in readResult), "envelope must not leak");
  });

  check("narrowed read result is normalized the same way", () => {
    assert.equal(narrowedResult.trace_id, "trace-read-1");
    assert.equal(narrowedResult.total, 1);
  });

  // -------------------------------------------------------------------------
  // Report
  // -------------------------------------------------------------------------
  console.log("demo checks");
  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed += 1;
    console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.label}${r.ok ? "" : `\n        -> ${r.detail}`}`);
  }
  console.log(`\n${results.length - failed}/${results.length} checks passed`);

  if (failed > 0) {
    process.exitCode = 1;
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
}
