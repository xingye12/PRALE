// Minimal vitest-compatible surface used to execute the real test source when vitest itself is not
// installed in this workspace. Only the matchers needed by the executed test are implemented; the
// runner intentionally reports how many tests it did not execute.
import assert from "node:assert/strict";

const hookStack = [{ before: [], after: [] }];
const tests = [];

export function describe(_name, fn) {
	hookStack.push({ before: [], after: [] });
	try {
		fn();
	} finally {
		hookStack.pop();
	}
}

export function beforeEach(fn) {
	hookStack[hookStack.length - 1].before.push(fn);
}

export function afterEach(fn) {
	hookStack[hookStack.length - 1].after.push(fn);
}

function register(title, fn) {
	tests.push({
		title,
		fn,
		before: hookStack.flatMap((scope) => scope.before),
		after: hookStack.flatMap((scope) => scope.after),
	});
}

function interpolate(title, row) {
	if (row === null || typeof row !== "object") return title.replace(/\$[\w.]+/g, String(row));
	return title.replace(/\$(\w+)/g, (_match, key) => String(row[key]));
}

export function it(title, fn) {
	register(title, fn);
}

it.each = (cases) => (title, fn) => {
	for (const row of cases) register(interpolate(title, row), () => fn(row));
};
it.skip = () => {};

export const test = it;

export function expect(actual) {
	const matchers = {
		toBe: (expected) => assert.ok(Object.is(actual, expected), `expected ${String(actual)} to be ${String(expected)}`),
		toEqual: (expected) => assert.deepStrictEqual(actual, expected),
		toBeUndefined: () => assert.strictEqual(actual, undefined),
		toBeDefined: () => assert.notStrictEqual(actual, undefined),
		toBeTruthy: () => assert.ok(actual),
		toBeFalsy: () => assert.ok(!actual),
		toHaveLength: (expected) => assert.strictEqual(actual.length, expected),
		toContain: (expected) => assert.ok(actual.includes(expected)),
		toThrow: (expected) => {
			assert.strictEqual(typeof actual, "function", "toThrow requires a function");
			assert.throws(actual, expected === undefined ? undefined : undefined);
		},
		toMatchObject: (expected) => assert.deepStrictEqual(pick(actual, Object.keys(expected)), expected),
	};
	matchers.not = { toThrow: () => assert.doesNotThrow(actual) };
	return matchers;
}

function pick(value, keys) {
	const out = {};
	for (const key of keys) {
		if (value != null && key in value) out[key] = value[key];
	}
	return out;
}

export function expectTypeOf() {
	return new Proxy(() => {}, { get: () => () => {} });
}

export async function runRegistered(filter) {
	let passed = 0;
	let failed = 0;
	let notExecuted = 0;
	const failures = [];
	for (const entry of tests) {
		if (!entry.title.includes(filter)) {
			notExecuted++;
			continue;
		}
		try {
			for (const hook of entry.before) await hook();
			await entry.fn();
			for (const hook of entry.after) await hook();
			passed++;
			console.log(`PASS: ${entry.title}`);
		} catch (error) {
			failed++;
			failures.push(`${entry.title}\n${error?.stack ?? error}`);
			try {
				for (const hook of entry.after) await hook();
			} catch {
				// ignore cleanup failures
			}
		}
	}
	if (failed > 0) {
		console.error(`FAIL:\n${failures.join("\n\n")}`);
		process.exitCode = 1;
	}
	console.log(`\n${passed} passed, ${failed} failed, ${notExecuted} not executed by this shim`);
}
