/**
 * Regression for session-migration/correction.
 *
 * Policy under test: when a legacy session file at the agent root collides with
 * an already-existing destination file, the existing destination always wins.
 * Both copies keep their exact bytes and unrelated legacy files still migrate.
 *
 * The real production function `migrateSessionsFromAgentRoot` is loaded through
 * `.prale-eval/subject.mjs` (TypeScript stripping + explicit boundary fakes for
 * `getAgentDir`/`stripBom`; real fs/path). No mocks of fs are used, so the test
 * exercises the real read/rename behavior of the production code.
 *
 * Run: node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadMigrations } from './subject.mjs';

const root = resolve(import.meta.dirname, '..');

/** Same directory-name encoding as session-manager.ts / migrations.ts. */
function encodeCwd(cwd) {
	return `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

/** Build a minimal but realistic legacy session file. */
function legacySession({ id, cwd, marker }) {
	const header = JSON.stringify({ type: 'session', id, version: 3, timestamp: '2025-01-01T00:00:00.000Z', cwd });
	const message = JSON.stringify({
		type: 'message',
		id: 'abc12345',
		parentId: null,
		timestamp: '2025-01-01T00:00:01.000Z',
		message: { role: 'user', content: marker, timestamp: 1 },
	});
	return `${header}\n${message}\n`;
}

const COLLIDING_CWD = '/work/colliding-project';
const UNRELATED_CWD = '/work/unrelated-project';
const NESTED_CWD = '/work/nested-project';

const LEGACY_MARKER = 'LEGACY-SOURCE-BYTES-MUST-SURVIVE';
const DESTINATION_MARKER = 'EXISTING-DESTINATION-BYTES-MUST-WIN';

const tmpBase = mkdtempSync(join(import.meta.dirname, '.tmp-regression-'));
const agentDir = join(tmpBase, 'agent');

let failures = 0;
function check(label, fn) {
	try {
		fn();
	} catch (error) {
		failures += 1;
		console.error(`FAIL: ${label}\n${error instanceof Error ? error.message : String(error)}`);
	}
}

try {
	// --- Arrange ----------------------------------------------------------
	mkdirSync(agentDir, { recursive: true });

	// (a) Legacy source that collides with an existing destination file.
	const legacyColliding = join(agentDir, 'colliding-session.jsonl');
	const collidingBytes = legacySession({ id: 'legacy-collision', cwd: COLLIDING_CWD, marker: LEGACY_MARKER });
	writeFileSync(legacyColliding, collidingBytes, 'utf8');

	const collidingDir = join(agentDir, 'sessions', encodeCwd(COLLIDING_CWD));
	mkdirSync(collidingDir, { recursive: true });
	const collidingDestination = join(collidingDir, 'colliding-session.jsonl');
	const destinationBytes = legacySession({
		id: 'existing-destination',
		cwd: COLLIDING_CWD,
		marker: DESTINATION_MARKER,
	});
	writeFileSync(collidingDestination, destinationBytes, 'utf8');

	// (b) Unrelated legacy source: must still be migrated even though a
	//     collision was skipped earlier in the same run.
	const unrelatedName = 'unrelated-session.jsonl';
	const legacyUnrelated = join(agentDir, unrelatedName);
	const unrelatedBytes = legacySession({ id: 'unrelated', cwd: UNRELATED_CWD, marker: 'MIGRATE-ME' });
	writeFileSync(legacyUnrelated, unrelatedBytes, 'utf8');
	const unrelatedDir = join(agentDir, 'sessions', encodeCwd(UNRELATED_CWD));
	const unrelatedDestination = join(unrelatedDir, unrelatedName);

	// (c) Second collision whose destination *directory* already exists but has
	//     no file of that name: migration must still move it.
	const nestedName = 'nested-session.jsonl';
	const legacyNested = join(agentDir, nestedName);
	const nestedBytes = legacySession({ id: 'nested', cwd: NESTED_CWD, marker: 'NESTED-MIGRATE-ME' });
	writeFileSync(legacyNested, nestedBytes, 'utf8');
	const nestedDir = join(agentDir, 'sessions', encodeCwd(NESTED_CWD));
	mkdirSync(nestedDir, { recursive: true });
	const nestedDestination = join(nestedDir, nestedName);

	// --- Act --------------------------------------------------------------
	const migrations = await loadMigrations(root, agentDir);
	assert.strictEqual(typeof migrations.migrateSessionsFromAgentRoot, 'function', 'production export missing');
	migrations.migrateSessionsFromAgentRoot();

	// --- Assert -----------------------------------------------------------
	check('existing destination bytes are untouched (destination always wins)', () => {
		assert.ok(existsSync(collidingDestination), `destination disappeared: ${collidingDestination}`);
		assert.strictEqual(
			readFileSync(collidingDestination, 'utf8'),
			destinationBytes,
			'existing destination was overwritten by the colliding legacy source',
		);
	});

	check('colliding legacy source is left in place with its bytes', () => {
		assert.ok(existsSync(legacyColliding), 'colliding legacy source was moved or deleted');
		assert.strictEqual(
			readFileSync(legacyColliding, 'utf8'),
			collidingBytes,
			'colliding legacy source bytes changed',
		);
	});

	check('no stray copy of the colliding legacy file was created', () => {
		const entries = readdirSync(collidingDir).sort();
		assert.deepStrictEqual(entries, ['colliding-session.jsonl'], `unexpected files in ${collidingDir}`);
	});

	check('unrelated legacy file still migrates byte-for-byte', () => {
		assert.ok(!existsSync(legacyUnrelated), 'unrelated legacy source should have been moved');
		assert.ok(existsSync(unrelatedDestination), `unrelated session not migrated to ${unrelatedDestination}`);
		assert.strictEqual(readFileSync(unrelatedDestination, 'utf8'), unrelatedBytes, 'unrelated bytes changed');
	});

	check('legacy file migrates when only its destination directory exists', () => {
		assert.ok(!existsSync(legacyNested), 'legacy source with free destination slot should have been moved');
		assert.ok(existsSync(nestedDestination), `session not migrated to ${nestedDestination}`);
		assert.strictEqual(readFileSync(nestedDestination, 'utf8'), nestedBytes, 'nested bytes changed');
	});

	check('second run is idempotent and preserves both colliding copies', () => {
		migrations.migrateSessionsFromAgentRoot();
		assert.strictEqual(readFileSync(collidingDestination, 'utf8'), destinationBytes, 'destination mutated on rerun');
		assert.strictEqual(readFileSync(legacyColliding, 'utf8'), collidingBytes, 'legacy source mutated on rerun');
		assert.strictEqual(readFileSync(unrelatedDestination, 'utf8'), unrelatedBytes, 'migrated file mutated on rerun');
	});

	if (failures > 0) {
		throw new assert.AssertionError({ message: `${failures} migration collision check(s) failed` });
	}
	assert.ok(dirname(collidingDestination).includes(COLLIDING_CWD.replace(/\//g, '-').slice(1)));
	console.log('session migration collision policy: OK');
} finally {
	rmSync(tmpBase, { recursive: true, force: true });
}
