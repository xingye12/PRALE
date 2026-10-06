/**
 * panel-config.precedence.test.ts
 *
 * Precedence test for MemoryPanel instance/panel configuration.
 *
 * The panel resolves every configuration key from three sources that can conflict:
 *
 *   1. explicit request input — a value supplied explicitly at process launch,
 *      already present in `process.env` (most specific, wins);
 *   2. config — the deployment `.env` file, loaded by dotenv `config()`
 *      (`override:false` → an explicit value is never clobbered);
 *   3. default — the built-in fallback literal in `loadPanelConfig()`
 *      (MemoryPanel/src/panel/config/panel-config.ts).
 *
 * These tests force all three sources to disagree for the same key and assert which
 * one wins, including the per-key illegal-value behaviour (envInt is lenient and
 * returns its fallback; envBool is strict and collapses non-canonical input to false).
 *
 * Run: `pnpm --dir MemoryPanel test`
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

// `panel-config.ts` calls dotenv's `config()` at module init. Mock it so the test
// controls the "config" layer deterministically (and applies dotenv's real
// override:false rule, which is part of the precedence contract under test).
const { dotenvConfig } = vi.hoisted(() => ({ dotenvConfig: vi.fn() }));
vi.mock('dotenv', () => ({ config: dotenvConfig }));

const MODULE_PATH = '../../src/panel/config/panel-config.ts';

/** Keys the panel reads; cleared before every scenario so cases cannot leak. */
const CONTROLLED_KEYS = [
  'HOST',
  'PORT',
  'METADATA_INSTANCES_CONFIG',
  'METADATA_REMOTE_TIMEOUT_MS',
  'UI_DIST_DIR',
  'LOG_LEVEL',
  'LOG_FORMAT',
  'KNOWLEDGE_SERVICE_URL',
  'KNOWLEDGE_AUTH_TOKEN',
  'KNOWLEDGE_TIMEOUT_MS',
  'KNOWLEDGE_LLM_BINDING_SYNC',
  'KNOWLEDGE_LLM_PROXY_BASE_URL',
  'TDAI_AGENT_TEMPLATE_DIR',
];

const ENV_SNAPSHOT = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in ENV_SNAPSHOT)) delete process.env[k];
  for (const [k, v] of Object.entries(ENV_SNAPSHOT)) process.env[k] = v;
  vi.resetModules();
});

interface Scenario {
  /** explicit request input layer (already-present process.env values) */
  explicit?: Record<string, string>;
  /** the .env "config" layer */
  envFile?: Record<string, string>;
}

/**
 * Seed the two input layers and load the module fresh, then return the resolved
 * PanelConfig produced by the real `loadPanelConfig()`.
 */
async function loadResolvedConfig({ explicit = {}, envFile = {} }: Scenario) {
  for (const k of CONTROLLED_KEYS) delete process.env[k];
  Object.assign(process.env, explicit);

  dotenvConfig.mockImplementation(() => {
    for (const [key, value] of Object.entries(envFile)) {
      // dotenv default `override:false`: never overwrite an explicit value.
      if (!Object.prototype.hasOwnProperty.call(process.env, key)) process.env[key] = value;
    }
    return { parsed: { ...envFile } };
  });

  vi.resetModules();
  const mod = (await import(MODULE_PATH)) as {
    loadPanelConfig: () => {
      server: { host: string; port: number };
      metadataInstancesConfig: string;
      metadataRemoteTimeoutMs: number;
      ui: { distDir: string };
      log: { level: string; format: string };
      knowledge: { baseUrl: string; authToken: string; timeoutMs: number };
      knowledgeLlmBinding: { sync: boolean; proxyBaseUrl: string };
      agentTemplateDir: string;
    };
  };
  return mod.loadPanelConfig();
}

describe('panel-config precedence: explicit request input > config > default', () => {
  it('explicit input wins when explicit, config and default all conflict', async () => {
    const cfg = await loadResolvedConfig({
      explicit: { PORT: '9999', KNOWLEDGE_SERVICE_URL: 'http://explicit-ks:2222' },
      envFile: {
        PORT: '8000',
        KNOWLEDGE_SERVICE_URL: 'http://config-ks:1111',
        TDAI_AGENT_TEMPLATE_DIR: '/from-env-file',
      },
    });

    expect(cfg.server.port).toBe(9999); // explicit > config(8000) > default(8123)
    expect(cfg.knowledge.baseUrl).toBe('http://explicit-ks:2222'); // explicit wins
    expect(cfg.agentTemplateDir).toBe('/from-env-file'); // config wins where no explicit
  });

  it('config (.env) wins over the built-in default when no explicit input is given', async () => {
    const cfg = await loadResolvedConfig({
      envFile: { PORT: '8000', KNOWLEDGE_TIMEOUT_MS: '2500', KNOWLEDGE_LLM_BINDING_SYNC: 'false' },
    });

    expect(cfg.server.port).toBe(8000); // config > default 8123
    expect(cfg.knowledge.timeoutMs).toBe(2500); // config > default 15000
    expect(cfg.knowledgeLlmBinding.sync).toBe(false); // config 'false' > default true
    expect(cfg.server.host).toBe('0.0.0.0'); // untouched key → default
  });

  it('every key resolves to its built-in default when neither explicit nor config is set', async () => {
    const cfg = await loadResolvedConfig({});

    expect(cfg.server).toEqual({ host: '0.0.0.0', port: 8123 });
    expect(cfg.metadataInstancesConfig).toBe('./config/metadata-instances.json');
    expect(cfg.metadataRemoteTimeoutMs).toBe(15000);
    expect(cfg.ui.distDir).toBe('./web/dist');
    expect(cfg.log).toEqual({ level: 'info', format: 'json' });
    expect(cfg.knowledge).toEqual({
      baseUrl: 'http://127.0.0.1:8421',
      authToken: '',
      timeoutMs: 15000,
    });
    expect(cfg.knowledgeLlmBinding).toEqual({
      sync: true,
      proxyBaseUrl: 'http://127.0.0.1:8096',
    });
    expect(cfg.agentTemplateDir).toBe('./data/agent-templates');
  });

  it('explicit non-finite numeric does NOT override: default wins over config too', async () => {
    const cfg = await loadResolvedConfig({
      explicit: { PORT: 'not-a-port', KNOWLEDGE_TIMEOUT_MS: '12abc' },
      envFile: { PORT: '8000', KNOWLEDGE_TIMEOUT_MS: '2500' },
    });

    // envInt() discards non-finite input and returns its fallback (the default),
    // it does not fall through to the .env value.
    expect(cfg.server.port).toBe(8123);
    expect(cfg.knowledge.timeoutMs).toBe(15000);
  });

  it('explicit empty string for a numeric key resolves to the default', async () => {
    const cfg = await loadResolvedConfig({
      explicit: { PORT: '', KNOWLEDGE_TIMEOUT_MS: '' },
      envFile: { PORT: '8000' },
    });

    expect(cfg.server.port).toBe(8123);
    expect(cfg.knowledge.timeoutMs).toBe(15000);
  });

  it('accepts a valid explicit value even when a conflicting config value exists', async () => {
    const cfg = await loadResolvedConfig({
      explicit: { PORT: '4321' },
      envFile: { PORT: '8000' },
    });

    expect(cfg.server.port).toBe(4321);
  });

  it('explicit invalid enum normalizes to the default; valid enum is honored', async () => {
    const cfg = await loadResolvedConfig({
      explicit: { LOG_LEVEL: 'verbose', LOG_FORMAT: 'pretty' },
      envFile: { LOG_LEVEL: 'warn' },
    });

    expect(cfg.log.level).toBe('info'); // invalid explicit → default, not the .env 'warn'
    expect(cfg.log.format).toBe('pretty'); // valid explicit honored
  });

  it('string keys use nullish coalescing: explicit "" beats both config and default', async () => {
    const cfg = await loadResolvedConfig({
      explicit: { UI_DIST_DIR: '' },
      envFile: { UI_DIST_DIR: '/from-env-file' },
    });

    expect(cfg.ui.distDir).toBe('');
  });

  it('envBool honors canonical explicit input and collapses non-canonical input to false', async () => {
    const canonical = await loadResolvedConfig({
      explicit: { KNOWLEDGE_LLM_BINDING_SYNC: '1' },
    });
    expect(canonical.knowledgeLlmBinding.sync).toBe(true);

    const explicitFalse = await loadResolvedConfig({
      explicit: { KNOWLEDGE_LLM_BINDING_SYNC: 'false' },
    });
    expect(explicitFalse.knowledgeLlmBinding.sync).toBe(false); // explicit beats default true

    const nonCanonical = await loadResolvedConfig({
      explicit: { KNOWLEDGE_LLM_BINDING_SYNC: 'yes' },
    });
    // envBool returns the strict boolean, not the fallback default.
    expect(nonCanonical.knowledgeLlmBinding.sync).toBe(false);
  });

  it('the instance registry path (metadataInstancesConfig) obeys the same precedence', async () => {
    const explicitWins = await loadResolvedConfig({
      explicit: { METADATA_INSTANCES_CONFIG: '/explicit/instances.json' },
      envFile: { METADATA_INSTANCES_CONFIG: '/config/instances.json' },
    });
    expect(explicitWins.metadataInstancesConfig).toBe('/explicit/instances.json');

    const configWins = await loadResolvedConfig({
      envFile: { METADATA_INSTANCES_CONFIG: '/config/instances.json' },
    });
    expect(configWins.metadataInstancesConfig).toBe('/config/instances.json');

    const fallback = await loadResolvedConfig({});
    expect(fallback.metadataInstancesConfig).toBe('./config/metadata-instances.json');
  });
});
