/**
 * Executable precedence demo for MemoryPanel instance/panel configuration.
 *
 * Contract under test — three layers, highest wins:
 *   1. explicit request input  (per-request x-tdai-service-id / service_id)
 *   2. panel config            (process.env for panel-config.ts; the
 *                              metadata-instances.json entry for instances)
 *   3. default                 (hard-coded fallbacks; proxy_endpoint falls back
 *                              to gateway_endpoint)
 *
 * The demo imports and calls the REPOSITORY'S REAL modules
 * (MemoryPanel/src/panel/config/panel-config.ts and instance-registry.ts).
 * Bare specifiers dotenv/zod are satisfied by in-memory resolution stubs
 * (see stub-hooks.mjs) because node_modules is not installed in this workspace;
 * those stubs are load-time only and are never consulted by the logic asserted
 * here.
 *
 * Run:
 *   node --import ./.prale-eval/register-stubs.mjs ./.prale-eval/precedence-demo.mjs
 */
import { loadPanelConfig } from '../MemoryPanel/src/panel/config/panel-config.ts';
import {
  InstanceRegistry,
  InstanceRegistryError,
} from '../MemoryPanel/src/panel/config/instance-registry.ts';

let pass = 0;
let fail = 0;
const results = [];

function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else fail++;
  results.push({ name, ok, actual, expected });
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}\n        got=${JSON.stringify(actual)} want=${JSON.stringify(expected)}`,
  );
}

function layer(n, title) {
  console.log(`\n── layer ${n}: ${title} ──`);
}

// ───────────────────────────────────────────────────────────────────────────
// Layer 3 — defaults (no env present)
// ───────────────────────────────────────────────────────────────────────────
layer(3, 'default: hard-coded fallbacks in loadPanelConfig()');
for (const k of [
  'PORT',
  'HOST',
  'METADATA_INSTANCES_CONFIG',
  'METADATA_REMOTE_TIMEOUT_MS',
  'KNOWLEDGE_SERVICE_URL',
  'KNOWLEDGE_TIMEOUT_MS',
  'LOG_LEVEL',
  'LOG_FORMAT',
  'UI_DIST_DIR',
]) {
  delete process.env[k];
}
const defaultCfg = loadPanelConfig();
check('default server.port', defaultCfg.server.port, 8123);
check('default server.host', defaultCfg.server.host, '0.0.0.0');
check(
  'default metadataInstancesConfig',
  defaultCfg.metadataInstancesConfig,
  './config/metadata-instances.json',
);
check('default knowledge.timeoutMs', defaultCfg.knowledge.timeoutMs, 15000);
check(
  'default knowledge.baseUrl',
  defaultCfg.knowledge.baseUrl,
  'http://127.0.0.1:8421',
);
check('default log.level', defaultCfg.log.level, 'info');
check('default log.format', defaultCfg.log.format, 'json');

// ───────────────────────────────────────────────────────────────────────────
// Layer 2 — config (env) conflicts with default
// ───────────────────────────────────────────────────────────────────────────
layer(2, 'config (env) overrides default when both are present');
process.env.PORT = '9000'; // conflicts with default 8123
process.env.KNOWLEDGE_TIMEOUT_MS = '7777'; // conflicts with default 15000
process.env.LOG_LEVEL = 'debug'; // conflicts with default 'info'
process.env.METADATA_INSTANCES_CONFIG = '/etc/tdam/instances.json';
const envCfg = loadPanelConfig();
check('config PORT beats default', envCfg.server.port, 9000);
check('config KNOWLEDGE_TIMEOUT_MS beats default', envCfg.knowledge.timeoutMs, 7777);
check('config LOG_LEVEL beats default', envCfg.log.level, 'debug');
check(
  'config METADATA_INSTANCES_CONFIG beats default',
  envCfg.metadataInstancesConfig,
  '/etc/tdam/instances.json',
);

// Degenerate config must NOT win over the default: empty / non-numeric fall back.
process.env.PORT = '';
process.env.KNOWLEDGE_TIMEOUT_MS = 'not-a-number';
check('empty config PORT falls back to default', loadPanelConfig().server.port, 8123);
check(
  'non-numeric config timeout falls back to default',
  loadPanelConfig().knowledge.timeoutMs,
  15000,
);
delete process.env.PORT;
delete process.env.KNOWLEDGE_TIMEOUT_MS;

// ───────────────────────────────────────────────────────────────────────────
// Layer 1 — explicit request input conflicts with instance config + default
// ───────────────────────────────────────────────────────────────────────────
layer(1, 'explicit request input (per-request instance id) selects the instance');
// Two configured instances ("config" entries) with DIFFERENT endpoints.
const registry = new InstanceRegistry([
  {
    instance_id: 'inst-a',
    name: 'A',
    gateway_endpoint: 'https://a.example.com',
    proxy_endpoint: 'https://proxy-a.example.com',
    api_key: 'ka',
  },
  {
    instance_id: 'inst-b',
    name: 'B',
    gateway_endpoint: 'https://b.example.com',
    // no proxy_endpoint -> default layer falls back to gateway_endpoint
    api_key: 'kb',
  },
]);

// The request carries x-tdai-service-id: inst-b. That explicit input SELECTS
// which configured entry wins — it does not merge with a default instance.
const selected = registry.resolve('inst-b');
check('request input selects configured instance', selected.instance_id, 'inst-b');
check('selected gateway_endpoint is config entry, not default', selected.gateway_endpoint, 'https://b.example.com');
check('selected api_key is config entry', selected.api_key, 'kb');

// Request input that matches NO config entry must not silently fall back to a
// default instance — it is rejected (INVALID_INSTANCE / HTTP 400).
let thrown = null;
try {
  registry.resolve('inst-ghost');
} catch (e) {
  thrown = e;
}
check('unknown request instance is rejected (no default fallback)', thrown instanceof InstanceRegistryError, true);
check('rejection code is 400', thrown && thrown.code, 400);
check('rejection code id', thrown && thrown.message, 'INVALID_INSTANCE');

// Default layer inside instance config: absent proxy_endpoint must fall back to
// gateway_endpoint (listPublic omits the field; consumer uses `??`).
const publicList = registry.listPublic();
const pubB = publicList.find((x) => x.instance_id === 'inst-b');
check('missing proxy_endpoint is omitted', 'proxy_endpoint' in pubB, false);
check(
  'consumer default falls back to gateway_endpoint',
  pubB.proxy_endpoint ?? pubB.gateway_endpoint,
  'https://b.example.com',
);
const pubA = publicList.find((x) => x.instance_id === 'inst-a');
check('explicit proxy_endpoint (config) wins over fallback', pubA.proxy_endpoint ?? pubA.gateway_endpoint, 'https://proxy-a.example.com');
check('api_key (secret) never exposed in public list', 'api_key' in pubA, false);

// ───────────────────────────────────────────────────────────────────────────
console.log(`\n=== ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exitCode = 1;
