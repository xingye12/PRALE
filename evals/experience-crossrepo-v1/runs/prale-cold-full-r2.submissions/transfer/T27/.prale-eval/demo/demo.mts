/**
 * T27 demo — "one write, then one scoped read" against a **local fake HTTP backend**.
 *
 * What is exercised (real SDK code, not a re-implementation):
 *   `sdk/memory-core/typescript/src/v3/client.ts`  -> `MemoryClient`
 *     · `addConversation()` — write path, requires a non-empty `session_id`
 *       (`IsolationContext.resolveSessionForWrite`).
 *     · `queryConversation()` — scoped read, session may be omitted
 *       (`IsolationContext.resolveSession`).
 *     · both spread `IsolationContext.baseBody()` (team/agent/user[/task])
 *       into the request body.
 *   `sdk/memory-core/typescript/src/v3/http.ts` -> `V3HttpTransport`
 *     · posts to `<endpoint>/v3/...`, unwraps the `{code,message,data}` envelope
 *       into the raw `data` object and re-attaches the `x-trace-id` response
 *       header as `trace_id` on the normalized result.
 *
 * The backend is a real `node:http` server bound to 127.0.0.1:0 (ephemeral
 * port), so the demo observes the actual wire requests — order, headers, body
 * scope fields — and then verifies the normalized, envelope-stripped results.
 *
 * Run:  node ./.prale-eval/demo/run-demo.mjs
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { MemoryClient } from "../../sdk/memory-core/typescript/src/v3/client.ts";
import type { MemoryClientConfig, Transport } from "../../sdk/memory-core/typescript/src/client.ts";
import type { V3MemoryClientConfig } from "../../sdk/memory-core/typescript/src/v3/types.ts";

// ── fixture scope ────────────────────────────────────────────────────────────
const TEAM_ID = "team-demo-42";
const AGENT_ID = "agent-demo-42";
const USER_ID = "user-demo-42";
const SESSION_ID = "session-demo-42";
const OTHER_USER_ID = "user-demo-other";
const OTHER_SESSION_ID = "session-demo-other";
const API_KEY = "sk-mem-demo-key";
const SERVICE_ID = "mem-instance-demo";

const WRITE_TRACE_ID = "trace-write-1";
const READ_TRACE_ID = "trace-read-1";

type Json = Record<string, unknown>;

interface RecordedRequest {
  seq: number;
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Json;
}

interface StoredMessage {
  id: string;
  role: string;
  content: string;
  team_id: string;
  agent_id: string;
  user_id: string;
  session_id: string;
}

// ── local fake HTTP backend ──────────────────────────────────────────────────
const recorded: RecordedRequest[] = [];
const store: StoredMessage[] = [
  // Seeded rows that must NOT appear in the scoped read: same team+agent but a
  // different user / a different session.
  {
    id: "seed-foreign-user",
    role: "user",
    content: "belongs to another user",
    team_id: TEAM_ID,
    agent_id: AGENT_ID,
    user_id: OTHER_USER_ID,
    session_id: SESSION_ID,
  },
  {
    id: "seed-foreign-session",
    role: "assistant",
    content: "belongs to another session",
    team_id: TEAM_ID,
    agent_id: AGENT_ID,
    user_id: USER_ID,
    session_id: OTHER_SESSION_ID,
  },
];

async function readJsonBody(req: IncomingMessage): Promise<Json> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) chunks.push(chunk as Uint8Array);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Json) : {};
}

function sendJson(res: ServerResponse, status: number, payload: Json, traceId: string): void {
  res.writeHead(status, { "content-type": "application/json", "x-trace-id": traceId });
  res.end(JSON.stringify(payload));
}

const server = createServer(async (req, res) => {
  const body = await readJsonBody(req);
  const path = (req.url ?? "").split("?")[0];
  recorded.push({
    seq: recorded.length + 1,
    method: req.method ?? "",
    path,
    headers: req.headers,
    body,
  });

  // Every v3 data-plane call must carry the strict-isolation triple.
  const missing = ["team_id", "agent_id", "user_id"].filter(
    (key) => typeof body[key] !== "string" || !(body[key] as string),
  );
  if (missing.length > 0) {
    sendJson(res, 400, { code: 40001, message: `missing isolation fields: ${missing.join(", ")}`, data: {} }, "trace-rejected");
    return;
  }

  if (path === "/v3/conversation/add") {
    if (typeof body.session_id !== "string" || !body.session_id) {
      sendJson(res, 400, { code: 40002, message: "session_id is required on the write path", data: {} }, "trace-rejected");
      return;
    }
    const messages = Array.isArray(body.messages) ? (body.messages as Json[]) : [];
    const accepted: string[] = [];
    messages.forEach((message, index) => {
      const id = `msg-${index + 1}`;
      accepted.push(id);
      store.push({
        id,
        role: String(message.role ?? ""),
        content: String(message.content ?? ""),
        team_id: String(body.team_id),
        agent_id: String(body.agent_id),
        user_id: String(body.user_id),
        session_id: String(body.session_id),
      });
    });
    sendJson(
      res,
      200,
      { code: 0, message: "ok", request_id: "req-write-1", data: { accepted_ids: accepted, total_count: accepted.length } },
      WRITE_TRACE_ID,
    );
    return;
  }

  if (path === "/v3/conversation/query") {
    const scoped = store.filter(
      (row) =>
        row.team_id === body.team_id &&
        row.agent_id === body.agent_id &&
        row.user_id === body.user_id &&
        (body.session_id === undefined || row.session_id === body.session_id),
    );
    const limit = typeof body.limit === "number" ? body.limit : 20;
    const offset = typeof body.offset === "number" ? body.offset : 0;
    const page = scoped.slice(offset, offset + limit);
    sendJson(
      res,
      200,
      {
        code: 0,
        message: "ok",
        request_id: "req-read-1",
        data: {
          messages: page.map((row) => ({ id: row.id, role: row.role, content: row.content })),
          total: scoped.length,
        },
      },
      READ_TRACE_ID,
    );
    return;
  }

  sendJson(res, 404, { code: 40400, message: `unknown path ${path}`, data: {} }, "trace-unknown");
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const port = (server.address() as AddressInfo).port;
const endpoint = `http://127.0.0.1:${port}`;

// ── checks ───────────────────────────────────────────────────────────────────
interface CheckResult {
  name: string;
  passed: boolean;
  detail: string;
}

const checks: CheckResult[] = [];

function check(name: string, passed: boolean, detail: string): void {
  checks.push({ name, passed, detail });
}

function deepEqual(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function scopeMismatches(body: Json, expected: Json): string[] {
  return Object.keys(expected).filter((key) => body[key] !== expected[key]).map(
    (key) => `${key}: expected ${JSON.stringify(expected[key])}, got ${JSON.stringify(body[key])}`,
  );
}

const sharedHttpConfig: MemoryClientConfig = {
  endpoint,
  apiKey: API_KEY,
  serviceId: SERVICE_ID,
  timeout: 5_000,
};

const clientConfig: V3MemoryClientConfig = {
  ...sharedHttpConfig,
  teamId: TEAM_ID,
  agentId: AGENT_ID,
  userId: USER_ID,
  sessionId: SESSION_ID,
};

const client = new MemoryClient(clientConfig);
const expectedScope: Json = {
  team_id: TEAM_ID,
  agent_id: AGENT_ID,
  user_id: USER_ID,
  session_id: SESSION_ID,
};

// 1) WRITE — L0 add. The construction-time session_id is the write scope.
const writeResult = await client.addConversation({
  messages: [
    { role: "user", content: "hello from the T27 demo" },
    { role: "assistant", content: "ack" },
  ],
});

// 2) SCOPED READ — same client/scope, so the read resolves to session-demo-42.
const readResult = await client.queryConversation({ limit: 20 });

// ── verification ─────────────────────────────────────────────────────────────
const order = recorded.map((request) => `${request.method} ${request.path}`);
check(
  "request order: exactly one write, then one scoped read",
  deepEqual(order, ["POST /v3/conversation/add", "POST /v3/conversation/query"]),
  `observed order = ${JSON.stringify(order)}`,
);

const writeRequest = recorded[0];
const readRequest = recorded[1];

check(
  "write request carries the full isolation scope",
  scopeMismatches(writeRequest.body, expectedScope).length === 0,
  scopeMismatches(writeRequest.body, expectedScope).join("; ") || "team_id/agent_id/user_id/session_id all match the client scope",
);

check(
  "write request authenticates with the configured credentials",
  writeRequest.headers.authorization === `Bearer ${API_KEY}` &&
    writeRequest.headers["x-tdai-service-id"] === SERVICE_ID &&
    writeRequest.headers["content-type"] === "application/json",
  `authorization=${JSON.stringify(writeRequest.headers.authorization)}, x-tdai-service-id=${JSON.stringify(writeRequest.headers["x-tdai-service-id"])}, content-type=${JSON.stringify(writeRequest.headers["content-type"])}`,
);

const readScopeMismatches = scopeMismatches(readRequest.body, expectedScope);
check(
  "scoped read reuses the isolation scope and the configured session",
  readScopeMismatches.length === 0 &&
    readRequest.body.limit === 20 &&
    !("offset" in readRequest.body) &&
    !("time_start" in readRequest.body),
  (readScopeMismatches.join("; ") || "team_id/agent_id/user_id/session_id all match the client scope") +
    `; limit=${JSON.stringify(readRequest.body.limit)}; undefined fields stripped from body = ${
      !("offset" in readRequest.body) && !("time_start" in readRequest.body)
    }`,
);

check(
  "normalized write result: envelope unwrapped + trace_id normalized",
  deepEqual(writeResult, { accepted_ids: ["msg-1", "msg-2"], total_count: 2, trace_id: WRITE_TRACE_ID }),
  `writeResult = ${JSON.stringify(writeResult)}`,
);

check(
  "normalized scoped read result: only in-scope messages, envelope unwrapped + trace_id normalized",
  deepEqual(readResult, {
    messages: [
      { id: "msg-1", role: "user", content: "hello from the T27 demo" },
      { id: "msg-2", role: "assistant", content: "ack" },
    ],
    total: 2,
    trace_id: READ_TRACE_ID,
  }),
  `readResult = ${JSON.stringify(readResult)} (foreign user/session seed rows excluded)`,
);

// The SDK also exposes a transport seam (src/client.ts `Transport`) used by
// tests/embedders: wiring a custom transport must not produce backend traffic.
const seamPaths: string[] = [];
const seamTransport: Transport = {
  post: async (path) => {
    seamPaths.push(path);
    return {};
  },
};
const seamClient = new MemoryClient(seamTransport, {
  team_id: TEAM_ID,
  agent_id: AGENT_ID,
  user_id: USER_ID,
  session_id: SESSION_ID,
});
const resecopedSeamClient = seamClient.withIsolation({ userId: OTHER_USER_ID });

check(
  "Transport seam: MemoryClient accepts an injected Transport and re-scopes without extra HTTP traffic",
  seamClient instanceof MemoryClient && resecopedSeamClient instanceof MemoryClient && seamPaths.length === 0 && recorded.length === 2,
  `injected-transport calls=${seamPaths.length}, backend requests=${recorded.length}`,
);

// ── report ───────────────────────────────────────────────────────────────────
const passed = checks.every((entry) => entry.passed);
const report = {
  task_id: "T27",
  demo: "one write then one scoped read against a local fake HTTP backend",
  backend: `${endpoint} (node:http, 127.0.0.1, ephemeral port)`,
  requests: recorded.map((request) => ({
    seq: request.seq,
    method: request.method,
    path: request.path,
    authorization: request.headers.authorization,
    service_id_header: request.headers["x-tdai-service-id"],
    scope: {
      team_id: request.body.team_id,
      agent_id: request.body.agent_id,
      user_id: request.body.user_id,
      session_id: request.body.session_id ?? null,
    },
    body_keys: Object.keys(request.body),
  })),
  normalized_results: { write: writeResult, read: readResult },
  checks,
  passed,
};

console.log(JSON.stringify(report, null, 2));

server.closeAllConnections();
await new Promise<void>((resolve) => server.close(() => resolve()));
process.exit(passed ? 0 : 1);
