import * as fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
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
for (const f of ['packages/coding-agent/src/core/resource-loader.ts','packages/coding-agent/src/core/settings-manager.ts','packages/coding-agent/src/core/project-trust.ts']) {
  const src = stripTypeScriptTypes(fs.readFileSync(f,'utf8'), { mode: 'strip' });
  console.log('===', f);
  for (const [spec, names] of importsFor(src)) console.log(' ', spec, [...names].join(','));
}
