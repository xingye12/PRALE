/**
 * Faithful minimal stand-in for the `dotenv` package used by
 * MemoryPanel/src/panel/config/panel-config.ts.
 *
 * panel-config.ts calls `loadDotenv()` (dotenv's `config()`) at module init with NO
 * options. dotenv's documented default is `override: false`: values coming from the
 * `.env` file are written into `process.env` ONLY for keys that are not already
 * present. That is exactly the precedence rule under test here:
 *
 *   explicit process input (already present)  >  .env file (config)  >  built-in default
 *
 * This stub reproduces that rule so the REAL panel-config.ts can run unmodified
 * without installing node_modules. It never overrides an existing key.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function config(options = {}) {
  const path = options.path ? resolve(options.path) : resolve(process.cwd(), '.env');
  let text = '';
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { parsed: {} };
  }
  const parsed = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    // dotenv `override: false` semantics — never clobber an explicit value.
    if (!Object.prototype.hasOwnProperty.call(process.env, key)) {
      process.env[key] = val;
    }
    parsed[key] = val;
  }
  return { parsed };
}

export default { config };
