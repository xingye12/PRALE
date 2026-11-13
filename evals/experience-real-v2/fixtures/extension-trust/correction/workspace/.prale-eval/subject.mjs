/** Generic local TypeScript test support. No repository entry points or scenarios.
 * Discover the implementation first; supply relative module paths and boundary
 * bindings yourself. Run with Node 24 and --experimental-vm-modules.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isBuiltin, stripTypeScriptTypes } from 'node:module';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';

function importsFor(source) {
  const imports = new Map();
  for (const [, clause, specifier] of source.matchAll(/\bimport\s+([^;]+?)\s+from\s+["']([^"']+)["'];/g)) {
    const names = new Set(imports.get(specifier) ?? []);
    if (!clause.trim().startsWith('{')) names.add('default');
    const group = clause.match(/\{([^}]+)\}/);
    if (group) for (const part of group[1].split(',')) {
      const name = part.trim().split(/\s+/)[0];
      if (name) names.add(name);
    }
    imports.set(specifier, names);
  }
  return imports;
}

/** modules: array of workspace-relative paths, or alias -> path object.
 * Only these modules execute as real code. Other non-builtin imports use
 * caller-supplied export-name bindings; unexpected calls throw. Builtins are
 * real unless overridden by {relativePath: {exportName: value}}.
 * trailers: optional {relativePath: source} to expose private functions for tests.
 * Each graph has a separate VM context and module cache.
 */
export function createGraph(root, modules, bindings = {}, builtinOverrides = {}, trailers = {}) {
  root = path.resolve(root);
  const aliases = Array.isArray(modules) ? Object.fromEntries(modules.map(p => [p, p])) : modules;
  const entrypoints = new Set(Object.values(aliases));
  const relativePath = value => {
    const relative = path.posix.normalize(value);
    if (path.isAbsolute(relative) || relative === '..' || relative.startsWith('../')) {
      throw new Error('Module paths must remain inside the workspace');
    }
    return relative;
  };
  const context = createContext({ console, Date, Map, Set, Promise, Error, TypeError,
    Buffer, AbortController, AbortSignal, structuredClone,
    process: { platform: process.platform, cwd: () => root, env: {} },
  });
  const cache = new Map();
  const imports = new Map();
  function get(value) {
    const relative = relativePath(value);
    if (cache.has(relative)) return cache.get(relative);
    const source = stripTypeScriptTypes(fs.readFileSync(path.join(root, relative), 'utf8'), { mode: 'strip' })
      + (trailers[relative] ?? '');
    const mod = new SourceTextModule(source, { context, identifier: relative });
    cache.set(relative, mod);
    imports.set(relative, importsFor(source));
    return mod;
  }
  async function link(specifier, parent) {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(parent.identifier), specifier));
    if (specifier.startsWith('.') && entrypoints.has(resolved)) return get(resolved);
    const builtin = isBuiltin(specifier) ? await import(specifier) : null;
    const names = builtin ? Object.keys(builtin) : [...(imports.get(parent.identifier)?.get(specifier) ?? [])];
    return new SyntheticModule(names, function () {
      for (const name of names) {
        const overrides = builtinOverrides[parent.identifier] ?? {};
        const value = builtin ? (Object.hasOwn(overrides, name) ? overrides[name]
          : name === 'default' && typeof builtin.default === 'object' && Object.keys(overrides).length
            ? { ...builtin.default, ...overrides } : builtin[name]) : bindings[name];
        this.setExport(name, value ?? function () { throw new Error(`Unexpected boundary: ${specifier}:${name}`); });
      }
    }, { context });
  }
  return {
    async module(name) {
      const mod = get(aliases[name] ?? name);
      if (mod.status === 'unlinked') await mod.link(link);
      if (mod.status === 'linked') await mod.evaluate({ timeout: 3000 });
      return mod.namespace;
    },
  };
}

/** Load one discovered module; use createGraph when real dependencies must link.
 * bindings replaces imported boundary exports. trailer is optional test-only source.
 */
export async function loadModule(root, relative, bindings = {}, trailer = '') {
  return createGraph(root, [relative], bindings, {}, { [relative]: trailer }).module(relative);
}
