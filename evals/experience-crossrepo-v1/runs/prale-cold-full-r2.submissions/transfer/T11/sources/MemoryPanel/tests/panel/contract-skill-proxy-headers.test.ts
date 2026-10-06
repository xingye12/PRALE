/**
 * T11 contract test — POST /api/v1/skill/* with missing / invalid required headers.
 *
 * "Different panel route" (vs. the `/meta/*` proxy covered by the earlier
 * contract): this exercises the **skill data-plane proxy** registered by
 * `registerSkillProxyRoutes()`. That route reuses the shared
 * `validatePanelMetaHeaders(deps)` middleware, so the header guard contract is
 * identical: a request that is missing `x-tdai-service-id`, references an
 * unknown instance, or (non-`auth/verify` action) is missing `x-tdai-user-key`
 * must short-circuit inside the middleware with the standard control envelope
 * (`{ code, message, request_id, data: null }`) and MUST NOT reach the route
 * handler — i.e. the downstream skill kernel client is never called.
 *
 * The last case in the file is the reachability proof: the *same* fake client
 * IS invoked once when the headers are valid, so `not.toHaveBeenCalled()` in
 * the rejection cases is meaningful and not an artefact of an unwired route.
 */
import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { InstanceRegistry } from '../../src/panel/config/instance-registry.js';
import type { MetaEnvelope } from '../../src/panel/kernel/envelope.js';
import type { PanelDeps } from '../../src/panel/panel-deps.js';
import { registerSkillProxyRoutes } from '../../src/panel/http/routes/skill/proxy.js';

const API_PREFIX = '/api/v1';
const SKILL_PATH = `${API_PREFIX}/skill/get`;

const INSTANCE_ID = 'inst-contract';
const USER_KEY = 'user-key-contract';

interface Harness {
  app: Hono;
  invoke: ReturnType<typeof vi.fn>;
}

function buildHarness(): Harness {
  // Downstream fake client: the skill kernel adapter. Records every call.
  const invoke = vi.fn(
    async (): Promise<MetaEnvelope<unknown>> => ({
      code: 0,
      message: 'ok',
      request_id: '',
      data: { ok: true },
    }),
  );

  const deps = {
    instanceRegistry: new InstanceRegistry([
      {
        instance_id: INSTANCE_ID,
        name: 'contract-instance',
        gateway_endpoint: 'http://kernel.invalid:8000',
        api_key: 'kernel-api-key',
      },
    ]),
    skillKernel: { invoke },
  } as unknown as PanelDeps;

  const api = new Hono();
  registerSkillProxyRoutes(api, deps);
  const app = new Hono();
  app.route(API_PREFIX, api);

  return { app, invoke };
}

function postSkill(
  app: Hono,
  headers: Record<string, string>,
  body: Record<string, unknown> = { skill_id: 'skl-1' },
): Promise<Response> {
  return app.request(SKILL_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('contract: POST /api/v1/skill/* required headers', () => {
  it('missing x-tdai-service-id -> 400 MISSING_INSTANCE_ID envelope, no downstream call', async () => {
    const { app, invoke } = buildHarness();

    const res = await postSkill(app, {});

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      code: 400,
      message: 'MISSING_INSTANCE_ID',
      request_id: expect.any(String),
      data: null,
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('unknown x-tdai-service-id -> 400 INVALID_INSTANCE envelope, no downstream call', async () => {
    const { app, invoke } = buildHarness();

    const res = await postSkill(app, { 'x-tdai-service-id': 'inst-does-not-exist' });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      code: 400,
      message: 'INVALID_INSTANCE',
      request_id: expect.any(String),
      data: null,
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('missing x-tdai-user-key -> 400 MISSING_USER_KEY envelope, no downstream call', async () => {
    const { app, invoke } = buildHarness();

    const res = await postSkill(app, { 'x-tdai-service-id': INSTANCE_ID });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      code: 400,
      message: 'MISSING_USER_KEY',
      request_id: expect.any(String),
      data: null,
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('blank (whitespace-only) headers are treated as missing', async () => {
    const { app, invoke } = buildHarness();

    const res = await postSkill(app, {
      'x-tdai-service-id': '   ',
      'x-tdai-user-key': '   ',
    });

    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe('MISSING_INSTANCE_ID');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('valid headers reach the handler and call the downstream fake exactly once', async () => {
    const { app, invoke } = buildHarness();

    const res = await postSkill(app, {
      'x-tdai-service-id': INSTANCE_ID,
      'x-tdai-user-key': USER_KEY,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      code: 0,
      message: 'ok',
      request_id: '',
      data: { ok: true },
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke.mock.calls[0][0]).toBe('get');
  });
});
