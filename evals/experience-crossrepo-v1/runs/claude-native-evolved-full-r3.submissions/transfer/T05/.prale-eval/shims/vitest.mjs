// Minimal offline stand-in for the `vitest` test API.
//
// The repo's vitest devDependency is not installed in this workspace and the
// task forbids installing it. This shim implements just enough of the API
// (describe / it / beforeEach / afterEach / expect) to execute the real
// tests/panel/config-precedence.test.ts offline and report pass/fail.
const hooks = [{ before: [], after: [] }];
const names = [];

let passed = 0;
let failed = 0;
const failures = [];

export function describe(name, fn) {
  names.push(name);
  hooks.push({ before: [], after: [] });
  try {
    fn();
  } finally {
    hooks.pop();
    names.pop();
  }
}

export function it(name, fn) {
  const label = [...names, name].join(' > ');
  const before = hooks.flatMap((h) => h.before);
  const after = hooks.flatMap((h) => h.after);
  let error = null;
  try {
    for (const h of before) h();
    fn();
  } catch (err) {
    error = err;
  }
  try {
    for (const h of after) h();
  } catch (err) {
    if (!error) error = err;
  }
  if (error) {
    failed += 1;
    failures.push({ label, error: error.message });
    console.log(`FAIL - ${label}\n       ${error.message}`);
  } else {
    passed += 1;
    console.log(`ok   - ${label}`);
  }
}

export function beforeEach(fn) {
  hooks[hooks.length - 1].before.push(fn);
}

export function afterEach(fn) {
  hooks[hooks.length - 1].after.push(fn);
}

function show(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function expect(actual) {
  return {
    toBe(expected) {
      if (!Object.is(actual, expected)) {
        throw new Error(`expected ${show(expected)}, got ${show(actual)}`);
      }
    },
    toEqual(expected) {
      if (show(actual) !== show(expected)) {
        throw new Error(`expected ${show(expected)}, got ${show(actual)}`);
      }
    },
    toBeUndefined() {
      if (actual !== undefined) throw new Error(`expected undefined, got ${show(actual)}`);
    },
  };
}

export default { describe, it, beforeEach, afterEach, expect };

process.on('exit', () => {
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
});
