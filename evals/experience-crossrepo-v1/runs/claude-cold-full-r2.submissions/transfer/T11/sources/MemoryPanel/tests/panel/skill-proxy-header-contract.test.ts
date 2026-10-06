/**
 * Header-gate contract: `POST /api/v1/skill/*` (Skill 数据面透明代理).
 *
 * This contracts a panel route *different* from the task/list-with-agents
 * aggregation route: the skill proxy. It is guarded by the shared
 * `validatePanelMetaHeaders` middleware, which is the single choke point for
 * `x-tdai-service-id` / `x-tdai-user-key` enforcement across the panel.
 *
 * Contract under test
 * -------------------
 * For every request whose required headers are missing or invalid
 * (`x-tdai-service-id` absent/blank, unknown instance, `x-tdai-user-key`
 * absent/blank on a non-`auth/verify` route) the panel must:
 *   1. short-circuit inside the middleware and return the *standard control
 *      envelope* `{ code, message, request_id, data: null }` with HTTP 400; and
 *   2. never reach the handler, i.e. never call the downstream fake client
 *      (`deps.skillKernel.invoke`) nor the meta client.
 *
 * A happy-path control case proves the fake client *would* be invoked when the
 * headers are valid, so the negative "never called" assertions are meaningful.
 */
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { InstanceRegistry } from "../../src/panel/config/instance-registry.js";
import type { PanelDeps } from "../../src/panel/panel-deps.js";
import type { Logger } from "../../src/panel/infra/logger.js";
import { requestLogger } from "../../src/panel/http/middleware/request-logger.js";
import { registerSkillProxyRoutes } from "../../src/panel/http/routes/skill/proxy.js";

const SERVICE_ID_HEADER = "x-tdai-service-id";
const USER_KEY_HEADER = "x-tdai-user-key";
const REQUEST_ID_HEADER = "x-request-id";

function makeLogger(): Logger {
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
  };
  return logger;
}

/** Recording downstream fake client + minimal deps for the skill proxy route. */
function makeHarness() {
  const registry = new InstanceRegistry([
    {
      instance_id: "inst-1",
      name: "contract-test",
      gateway_endpoint: "https://kernel.example.test",
      api_key: "sk-test-key",
    },
  ]);

  // Downstream fake clients: anything the panel would call to serve the route.
  const fakeSkillKernel = { invoke: vi.fn(async () => ({ code: 0, message: "ok", request_id: "k-1", data: {} })) };
  const fakeMetaKernel = { invoke: vi.fn(async () => ({ code: 0, message: "ok", request_id: "k-1", data: {} })) };

  const deps = {
    instanceRegistry: registry,
    skillKernel: fakeSkillKernel,
    metaKernel: fakeMetaKernel,
    logger: makeLogger(),
  } as unknown as PanelDeps;

  const api = new Hono();
  registerSkillProxyRoutes(api, deps);
  const app = new Hono();
  app.use("*", requestLogger(deps.logger));
  app.route("/api/v1", api);

  return { app, fakeSkillKernel, fakeMetaKernel };
}

function post(app: Hono, path: string, headers: Record<string, string> = {}) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ team_id: "team-1" }),
  });
}

describe("POST /api/v1/skill/* header gate contract", () => {
  it("missing x-tdai-service-id -> standard 400 envelope, downstream untouched", async () => {
    const { app, fakeSkillKernel, fakeMetaKernel } = makeHarness();
    const res = await post(app, "/api/v1/skill/list", {
      [REQUEST_ID_HEADER]: "req-missing-instance",
      [USER_KEY_HEADER]: "uk-1",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      code: 400,
      message: "MISSING_INSTANCE_ID",
      request_id: "req-missing-instance",
      data: null,
    });
    expect(fakeSkillKernel.invoke).not.toHaveBeenCalled();
    expect(fakeMetaKernel.invoke).not.toHaveBeenCalled();
  });

  it("blank x-tdai-service-id is trimmed to missing -> 400, downstream untouched", async () => {
    const { app, fakeSkillKernel } = makeHarness();
    const res = await post(app, "/api/v1/skill/list", {
      [REQUEST_ID_HEADER]: "req-blank-instance",
      [SERVICE_ID_HEADER]: "   ",
      [USER_KEY_HEADER]: "uk-1",
    });

    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe("MISSING_INSTANCE_ID");
    expect(fakeSkillKernel.invoke).not.toHaveBeenCalled();
  });

  it("unknown instance id -> 400 INVALID_INSTANCE, downstream untouched", async () => {
    const { app, fakeSkillKernel } = makeHarness();
    const res = await post(app, "/api/v1/skill/list", {
      [REQUEST_ID_HEADER]: "req-bad-instance",
      [SERVICE_ID_HEADER]: "inst-does-not-exist",
      [USER_KEY_HEADER]: "uk-1",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      code: 400,
      message: "INVALID_INSTANCE",
      request_id: "req-bad-instance",
      data: null,
    });
    expect(fakeSkillKernel.invoke).not.toHaveBeenCalled();
  });

  it("known instance but missing x-tdai-user-key -> 400 MISSING_USER_KEY, downstream untouched", async () => {
    const { app, fakeSkillKernel } = makeHarness();
    const res = await post(app, "/api/v1/skill/files/write", {
      [REQUEST_ID_HEADER]: "req-missing-userkey",
      [SERVICE_ID_HEADER]: "inst-1",
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      code: 400,
      message: "MISSING_USER_KEY",
      request_id: "req-missing-userkey",
      data: null,
    });
    expect(fakeSkillKernel.invoke).not.toHaveBeenCalled();
  });

  it("blank x-tdai-user-key is trimmed to missing -> 400, downstream untouched", async () => {
    const { app, fakeSkillKernel } = makeHarness();
    const res = await post(app, "/api/v1/skill/list", {
      [SERVICE_ID_HEADER]: "inst-1",
      [USER_KEY_HEADER]: "  ",
    });

    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe("MISSING_USER_KEY");
    expect(fakeSkillKernel.invoke).not.toHaveBeenCalled();
  });

  it("control: valid headers reach the handler and invoke the downstream client once", async () => {
    const { app, fakeSkillKernel, fakeMetaKernel } = makeHarness();
    const res = await post(app, "/api/v1/skill/list", {
      [REQUEST_ID_HEADER]: "req-ok",
      [SERVICE_ID_HEADER]: "inst-1",
      [USER_KEY_HEADER]: "uk-1",
    });

    expect(res.status).toBe(200);
    expect(fakeSkillKernel.invoke).toHaveBeenCalledTimes(1);
    expect(fakeSkillKernel.invoke).toHaveBeenCalledWith(
      "list",
      { team_id: "team-1" },
      expect.objectContaining({
        instanceId: "inst-1",
        gatewayEndpoint: "https://kernel.example.test",
        gatewayApiKey: "sk-test-key",
        userKey: "uk-1",
      }),
    );
    // The skill path never touches the meta client.
    expect(fakeMetaKernel.invoke).not.toHaveBeenCalled();
  });
});
