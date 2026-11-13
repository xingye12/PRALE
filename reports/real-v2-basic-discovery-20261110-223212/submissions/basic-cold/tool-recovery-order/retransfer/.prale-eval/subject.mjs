/** Public test support, not a reference implementation or a behavioral oracle.
 * Loads complete submitted TypeScript modules using Node 24. Imports at external
 * boundaries are faked; unexpected boundary calls throw. No npm install required.
 */
import { readFileSync } from 'node:fs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';

export const targets = {
  trust: 'packages/coding-agent/src/core/resource-loader.ts',
  migration: 'packages/coding-agent/src/migrations.ts',
  recovery: 'packages/agent/src/harness/runtime/drive/tools.ts',
};

async function load(root, target, bindings, trailer = '') {
  const filename = path.join(root, target);
  const source = stripTypeScriptTypes(readFileSync(filename, 'utf8'), { mode: 'strip' }) + trailer;
  const context = createContext({ console, Date, Map, Set, Promise });
  const mod = new SourceTextModule(source, { context, identifier: filename });
  // Read imports only to construct linkage. No target behavior is extracted or rewritten.
  const imports = new Map();
  for (const match of source.matchAll(/\bimport\s+([^;]+?)\s+from\s+["']([^"']+)["'];/g)) {
    const [, clause, specifier] = match;
    const names = new Set(imports.get(specifier) ?? []);
    if (!clause.trim().startsWith('{')) names.add('default');
    const group = clause.match(/\{([^}]+)\}/);
    if (group) for (const part of group[1].split(',')) {
      const name = part.trim().split(/\s+/)[0];
      if (name) names.add(name);
    }
    imports.set(specifier, names);
  }
  await mod.link(async (specifier) => {
    const builtin = ['fs', 'node:fs'].includes(specifier) ? fs
      : ['path', 'node:path'].includes(specifier) ? path : null;
    const names = builtin ? Object.keys(builtin) : [...(imports.get(specifier) ?? [])];
    return new SyntheticModule(names, function () {
      for (const name of names) {
        const value = builtin ? builtin[name] : bindings[name];
        this.setExport(name, value ?? function () {
          throw new Error(`Unexpected boundary call: ${specifier}:${name}`);
        });
      }
    }, { context });
  });
  await mod.evaluate({ timeout: 3000 });
  return mod.namespace;
}

/** Real migration functions, real fs/path, caller-owned temporary agentDir. */
export async function loadMigrations(root, agentDir) {
  return load(root, targets.migration, {
    getAgentDir: () => agentDir,
    stripBom: (text) => text.startsWith('\uFEFF') ? text.slice(1) : text,
  });
}

/** Execute the real loader lifecycle with settings/package/extension boundary fakes.
 * Returns {loader, events, state}; inspect loader.getExtensions() after reload.
 */
export async function createTrustSubject(root, { initialTrusted = true } = {}) {
  const events = [];
  const state = { trusted: initialTrusted, loadedTrust: initialTrusted };
  const extension = (name) => path.join(root, '.fixtures', `${name}.ts`);
  const paths = { user: extension('user'), project: extension('project'), cli: extension('cli') };
  const resources = (names) => ({
    extensions: names.map((name) => ({ path: paths[name], enabled: true,
      metadata: { source: 'local', scope: name === 'project' ? 'project' : 'user', origin: 'top-level' } })),
    skills: [], prompts: [], themes: [],
  });
  const settingsManager = {
    setProjectTrusted(value) { events.push(['set', value]); state.trusted = value; },
    async reload() { await Promise.resolve(); events.push(['settings', state.trusted]); state.loadedTrust = state.trusted; },
  };
  const packageManager = {
    async resolve() {
      events.push(['resolve', state.loadedTrust]);
      return resources(state.loadedTrust ? ['user', 'project'] : ['user']);
    },
    async resolveExtensionSources() { return resources(['cli']); },
  };
  const module = await load(root, targets.trust, {
    CONFIG_DIR_NAME: '.pi',
    DefaultPackageManager: class { constructor() { return packageManager; } },
    canonicalizePath: path.resolve,
    resolvePath: (value, cwd = root) => path.resolve(cwd, value),
    isLocalPath: () => false,
    createEventBus: () => ({}), createExtensionRuntime: () => ({}),
    resetTimings: () => {}, clearExtensionCache: () => {},
    createSourceInfo: (filename, metadata) => ({ path: filename, ...metadata }),
    async loadExtensionsCached(filenames, _cwd, _bus, runtime = {}) {
      events.push(['extensions', filenames.map((p) => path.basename(p))]);
      return { extensions: filenames.map((filename) => ({ path: filename, resolvedPath: filename,
        commands: new Map(), tools: new Map(), flags: new Map(), handlers: new Map() })), errors: [], runtime };
    },
  });
  const loader = new module.DefaultResourceLoader({
    cwd: root, agentDir: path.join(root, '.fixtures/user'), settingsManager,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    systemPrompt: '', appendSystemPrompt: [],
  });
  return { loader, events, state, paths };
}

/** Real recoverToolInvocation and interruptedOutcome. Only checkpoint IO, tool
 * execution and outcome publication are replaced by observable boundary fakes.
 * run(callPolicy, toolPolicy, cancelled, {checkpoint, effect}) -> events/outcome.
 * toolPolicy undefined means the tool is absent; null means a tool without policy.
 */
export async function createRecoverySubject(root) {
  const toolCall = { id: 'call-1', name: 'fixture-tool', arguments: {} };
  const module = await load(root, targets.recovery, { toolCallFor: () => toolCall }, `
export function __bindRecovery(hooks) {
  clearReplayCheckpoint = hooks.clear;
  readCheckpoint = hooks.read;
  performToolInvocation = hooks.invoke;
  publishToolOutcome = hooks.publish;
  return recoverToolInvocation;
}
`);
  return async (callPolicy, toolPolicy, cancelled, options = {}) => {
    const events = [];
    let outcome;
    const checkpoint = options.checkpoint ?? { content: [{ type: 'text', text: 'durable-progress' }], details: { step: 2 } };
    const recover = module.__bindRecovery({
      async clear() { events.push('clear'); return { persisted: 42 }; },
      async read() { events.push('read'); return checkpoint; },
      async invoke(_lane, _drive, _batch, _call, cleared, _context, recovery) {
        events.push('invoke');
        if (options.effect) await options.effect();
        events.push('effect-complete');
        return { toolCall, message: { content: [{ type: 'text', text: 'effect-result' }], isError: false },
          terminate: false, args: cleared.args, recovery };
      },
      async publish(_lane, _drive, _run, _call, result) { events.push('publish'); outcome = result; },
    });
    const tool = toolPolicy === undefined ? undefined : toolPolicy === null ? {} : { replay: toolPolicy };
    const task = await recover({}, {}, { batch: {} }, {}, { replay: callPolicy },
      new Map(tool === undefined ? [] : [[toolCall.name, tool]]), {}, cancelled);
    await task.completion;
    return { events, outcome };
  };
}
