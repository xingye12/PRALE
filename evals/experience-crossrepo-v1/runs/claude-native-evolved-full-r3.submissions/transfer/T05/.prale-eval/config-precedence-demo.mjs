// Executable precedence demo for MemoryPanel instance/panel configuration.
//
// Run (from the repository root):
//   node --import ./.prale-eval/register-loader.mjs ./.prale-eval/config-precedence-demo.mjs
//
// It imports the REAL MemoryPanel modules:
//   MemoryPanel/src/panel/config/panel-config.ts
//   MemoryPanel/src/panel/config/instance-registry.ts
// and asserts the three-tier precedence contract:
//
//   explicit request input  >  config  >  default
//
// The `dotenv` / `zod` runtime deps are not installed in this workspace and the
// task forbids installing them; .prale-eval/shims/ provides import-safe stubs
// registered by .prale-eval/register-loader.mjs. No production source is
// modified.

import { loadPanelConfig } from '../MemoryPanel/src/panel/config/panel-config.ts';
import {
  InstanceRegistry,
  InstanceRegistryError,
} from '../MemoryPanel/src/panel/config/instance-registry.ts';
import { META_HEADER_SERVICE_ID } from '../MemoryPanel/src/panel/kernel/headers.ts';

// ---------------------------------------------------------------- mini runner
let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok   - ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, error: err.message });
    console.log(`FAIL - ${name}\n       ${err.message}`);
  }
}

function expectEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`);
}

// ------------------------------------------------ process.env save / restore
const ENV_KEYS = [
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
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
}
function restoreEnv() {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

// Hardcoded fallbacks declared in panel-config.ts (the `default` tier).
const DEFAULT_PORT = 8123;
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_INSTANCES_PATH = './config/metadata-instances.json';
const DEFAULT_KNOWLEDGE_URL = 'http://127.0.0.1:8421';
const DEFAULT_PROXY_URL = 'http://127.0.0.1:8096';
const DEFAULT_TEMPLATE_DIR = './data/agent-templates';

// ============================================================ panel config
console.log('\n# panel config precedence (config > default)');
console.log('  module: MemoryPanel/src/panel/config/panel-config.ts');

test('defaults: with no env set, every knob falls back to its literal default', () => {
  clearEnv();
  const c = loadPanelConfig();
  expectEq(c.server.port, DEFAULT_PORT, 'server.port');
  expectEq(c.server.host, DEFAULT_HOST, 'server.host');
  expectEq(c.metadataRemoteTimeoutMs, DEFAULT_TIMEOUT_MS, 'metadataRemoteTimeoutMs');
  expectEq(c.metadataInstancesConfig, DEFAULT_INSTANCES_PATH, 'metadataInstancesConfig');
  expectEq(c.log.level, 'info', 'log.level');
  expectEq(c.log.format, 'json', 'log.format');
  expectEq(c.knowledge.baseUrl, DEFAULT_KNOWLEDGE_URL, 'knowledge.baseUrl');
  expectEq(c.knowledge.timeoutMs, DEFAULT_TIMEOUT_MS, 'knowledge.timeoutMs');
  expectEq(c.knowledgeLlmBinding.sync, true, 'knowledgeLlmBinding.sync');
  expectEq(c.knowledgeLlmBinding.proxyBaseUrl, DEFAULT_PROXY_URL, 'knowledgeLlmBinding.proxyBaseUrl');
  expectEq(c.agentTemplateDir, DEFAULT_TEMPLATE_DIR, 'agentTemplateDir');
});

test('config beats default: explicit env values win over every conflicting default', () => {
  clearEnv();
  process.env.PORT = '9000';
  process.env.HOST = '127.0.0.1';
  process.env.METADATA_REMOTE_TIMEOUT_MS = '1234';
  process.env.METADATA_INSTANCES_CONFIG = '/etc/panel/instances.json';
  process.env.LOG_LEVEL = 'debug';
  process.env.LOG_FORMAT = 'pretty';
  process.env.KNOWLEDGE_SERVICE_URL = 'https://ks.internal:8421';
  process.env.KNOWLEDGE_TIMEOUT_MS = '4321';
  process.env.KNOWLEDGE_LLM_BINDING_SYNC = 'false';
  process.env.KNOWLEDGE_LLM_PROXY_BASE_URL = 'https://proxy.internal:8096';
  process.env.TDAI_AGENT_TEMPLATE_DIR = '/srv/agent-templates';

  const c = loadPanelConfig();
  expectEq(c.server.port, 9000, 'server.port');
  expectEq(c.server.host, '127.0.0.1', 'server.host');
  expectEq(c.metadataRemoteTimeoutMs, 1234, 'metadataRemoteTimeoutMs');
  expectEq(c.metadataInstancesConfig, '/etc/panel/instances.json', 'metadataInstancesConfig');
  expectEq(c.log.level, 'debug', 'log.level');
  expectEq(c.log.format, 'pretty', 'log.format');
  expectEq(c.knowledge.baseUrl, 'https://ks.internal:8421', 'knowledge.baseUrl');
  expectEq(c.knowledge.timeoutMs, 4321, 'knowledge.timeoutMs');
  expectEq(c.knowledgeLlmBinding.sync, false, 'knowledgeLlmBinding.sync');
  expectEq(c.knowledgeLlmBinding.proxyBaseUrl, 'https://proxy.internal:8096', 'knowledgeLlmBinding.proxyBaseUrl');
  expectEq(c.agentTemplateDir, '/srv/agent-templates', 'agentTemplateDir');
});

test('empty-string config is treated as absent for int/bool knobs (falls to default)', () => {
  clearEnv();
  process.env.PORT = '';
  process.env.METADATA_REMOTE_TIMEOUT_MS = '';
  process.env.KNOWLEDGE_LLM_BINDING_SYNC = '';
  const c = loadPanelConfig();
  expectEq(c.server.port, DEFAULT_PORT, 'server.port');
  expectEq(c.metadataRemoteTimeoutMs, DEFAULT_TIMEOUT_MS, 'metadataRemoteTimeoutMs');
  expectEq(c.knowledgeLlmBinding.sync, true, 'knowledgeLlmBinding.sync');
});

test('invalid numeric config is rejected and falls to default', () => {
  clearEnv();
  process.env.PORT = 'not-a-number';
  process.env.KNOWLEDGE_TIMEOUT_MS = 'NaN';
  const c = loadPanelConfig();
  expectEq(c.server.port, DEFAULT_PORT, 'server.port');
  expectEq(c.knowledge.timeoutMs, DEFAULT_TIMEOUT_MS, 'knowledge.timeoutMs');
});

test('invalid enum config is guarded and falls to default', () => {
  clearEnv();
  process.env.LOG_LEVEL = 'verbose';
  process.env.LOG_FORMAT = 'yaml';
  const c = loadPanelConfig();
  expectEq(c.log.level, 'info', 'log.level');
  expectEq(c.log.format, 'json', 'log.format');
});

test('explicit input is re-read per call (config is not memoized)', () => {
  clearEnv();
  process.env.PORT = '7000';
  const first = loadPanelConfig();
  expectEq(first.server.port, 7000, 'first read');
  process.env.PORT = '8000';
  const second = loadPanelConfig();
  expectEq(second.server.port, 8000, 'second read wins over the earlier explicit value');
});

// ====================================================== instance registry
console.log('\n# instance config precedence (request input > instance config > default)');
console.log('  module: MemoryPanel/src/panel/config/instance-registry.ts');

// Instance `alpha` has no proxy_endpoint -> default fallback to gateway_endpoint.
// Instance `beta`  has a proxy_endpoint  -> explicit instance config wins.
const registry = new InstanceRegistry([
  {
    instance_id: 'alpha',
    name: 'Alpha',
    gateway_endpoint: 'https://alpha.gateway.example.com',
    api_key: 'sk-alpha',
  },
  {
    instance_id: 'beta',
    name: 'Beta',
    gateway_endpoint: 'https://beta.gateway.example.com',
    proxy_endpoint: 'https://beta.proxy.example.com',
    api_key: 'sk-beta',
  },
]);

test('explicit request input selects the instance (header x-tdai-service-id)', () => {
  expectEq(META_HEADER_SERVICE_ID, 'x-tdai-service-id', 'request header name');
  const entry = registry.resolve('beta');
  expectEq(entry.instance_id, 'beta', 'resolved instance_id');
  expectEq(entry.gateway_endpoint, 'https://beta.gateway.example.com', 'gateway_endpoint');
});

test('unknown explicit request input is rejected, not silently defaulted', () => {
  let code = null;
  let message = null;
  try {
    registry.resolve('gamma');
  } catch (err) {
    if (err instanceof InstanceRegistryError) {
      code = err.code;
      message = err.message;
    } else {
      throw err;
    }
  }
  expectEq(code, 400, 'error code');
  expectEq(message, 'INVALID_INSTANCE', 'error message');
});

test('instance config (proxy_endpoint) beats the gateway_endpoint default', () => {
  const beta = registry.listPublic().find((i) => i.instance_id === 'beta');
  expectEq(beta.proxy_endpoint, 'https://beta.proxy.example.com', 'beta client endpoint');
});

test('absent instance config leaves the default tier to the consumer (field omitted)', () => {
  const alpha = registry.listPublic().find((i) => i.instance_id === 'alpha');
  expectEq('proxy_endpoint' in alpha, false, 'proxy_endpoint key must be absent');
  const clientEndpoint = alpha.proxy_endpoint ?? alpha.gateway_endpoint;
  expectEq(clientEndpoint, 'https://alpha.gateway.example.com', 'default fallback endpoint');
});

test('three-way conflict: request picks the instance, config decides over default', () => {
  const requestHeader = 'beta'; // explicit request input
  const entry = registry.resolve(requestHeader);
  const clientEndpoint = entry.proxy_endpoint ?? entry.gateway_endpoint;
  expectEq(clientEndpoint, 'https://beta.proxy.example.com', 'config tier wins');
  const other = registry.resolve('alpha');
  const otherEndpoint = other.proxy_endpoint ?? other.gateway_endpoint;
  expectEq(otherEndpoint, 'https://alpha.gateway.example.com', 'default tier applies when config absent');
});

// ------------------------------------------------------------------- summary
restoreEnv();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  - ${f.name}: ${f.error}`);
  process.exitCode = 1;
}
