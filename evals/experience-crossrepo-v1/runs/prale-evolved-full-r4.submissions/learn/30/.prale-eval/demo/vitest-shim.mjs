/**
 * Minimal, dependency-free stand-in used only so the repository test file
 * `sdk/memory-core/typescript/tests/fake-transport-interaction.test.ts`
 * can be executed in this checkout, where `vitest` is not installed.
 *
 * It implements the subset of the `vitest` surface the test uses:
 * `describe`, `it`, `expect` (toBe / toEqual / toHaveLength / toThrow).
 * It is NOT a test framework replacement and is not shipped to consumers.
 */

const suites = [];
let current = null;

export function describe(name, fn) {
  const parent = current;
  const suite = { name, tests: [], suites: [], parent };
  if (parent) parent.suites.push(suite);
  else suites.push(suite);
  current = suite;
  fn();
  current = parent;
}

export function it(name, fn) {
  if (!current) throw new Error(`it("${name}") called outside describe()`);
  current.tests.push({ name, fn });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (typeof a === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((key) => deepEqual(a[key], b[key]));
  }
  return false;
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
      assert(Object.is(actual, expected), `expected ${show(actual)} toBe ${show(expected)}`);
    },
    toEqual(expected) {
      assert(deepEqual(actual, expected), `expected ${show(actual)} toEqual ${show(expected)}`);
    },
    toHaveLength(expected) {
      assert(
        actual != null && actual.length === expected,
        `expected length ${actual?.length} to equal ${expected}`,
      );
    },
    toThrow(expected) {
      assert(typeof actual === "function", "toThrow requires a function");
      let thrown = null;
      try {
        actual();
      } catch (error) {
        thrown = error;
      }
      assert(thrown !== null, "expected function to throw");
      if (typeof expected === "function") {
        assert(
          thrown instanceof expected,
          `expected ${thrown?.name ?? thrown} to be instance of ${expected.name}`,
        );
      }
    },
  };
}

export async function run() {
  const results = [];
  const walk = async (suite, path) => {
    const full = path ? `${path} > ${suite.name}` : suite.name;
    for (const test of suite.tests) {
      const label = `${full} > ${test.name}`;
      try {
        await test.fn();
        results.push({ label, status: "passed" });
      } catch (error) {
        results.push({ label, status: "failed", error: error?.message ?? String(error) });
      }
    }
    for (const child of suite.suites) await walk(child, full);
  };
  for (const suite of suites) await walk(suite, "");
  return results;
}
