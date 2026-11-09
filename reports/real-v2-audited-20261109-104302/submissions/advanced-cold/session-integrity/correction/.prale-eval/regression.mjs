#!/usr/bin/env node
/**
 * Regression: collision safety (migrations.ts) and invalid-header repair
 * (core/session-manager.ts) must agree.
 *
 * The real submitted modules are loaded through `.prale-eval/subject.mjs`
 * (createSessionPipeline wires the real migrations.ts -> real utils/text.ts,
 * paths.ts -> real core/session-manager.ts). Only filesystem locations are
 * supplied as boundaries; every read/write below hits the real modules.
 *
 * Run from the workspace root:
 *   node --experimental-vm-modules .prale-eval/regression.mjs
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createSessionPipeline } from './subject.mjs';

const workspace = process.cwd();
assert.ok(fs.existsSync(path.join(workspace, 'TASK.md')), 'run this script from the workspace root');

const scratch = path.join(workspace, '.prale-eval', '.tmp-regression');
const agentDir = path.join(scratch, 'agent');
const projAlpha = path.join(scratch, 'proj-alpha');
const projBeta = path.join(scratch, 'proj-beta');
const readerDir = path.join(scratch, 'reader');

const STAMP = '1970-01-01T00:00:00.000Z';

/** Deterministic, promise-ordered hand-off between the producing and consuming halves of a check. */
function deferred() {
	let resolve;
	const promise = new Promise((resolveFn) => {
		resolve = resolveFn;
	});
	return { promise, resolve };
}

const header = (id, cwd) => ({ type: 'session', version: 3, id, timestamp: STAMP, cwd });
const message = (id, text) => ({ type: 'message', id, parentId: null, timestamp: STAMP, message: { role: 'user', content: text } });

const write = (filePath, content) => {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, 'utf8');
	return filePath;
};
const read = (filePath) => fs.readFileSync(filePath, 'utf8');
/** Host-realm array of file-entry ids (VM-realm arrays cannot be deep-compared). */
const ids = (entries) => Array.from(entries, (entry) => entry.id);

function prepareScratch() {
	fs.rmSync(scratch, { recursive: true, force: true });
	for (const dir of [agentDir, projAlpha, projBeta, readerDir]) fs.mkdirSync(dir, { recursive: true });
}

async function checkMigrationsAndReader() {
	const { migration, session } = await createSessionPipeline(workspace, agentDir);
	assert.equal(typeof migration.migrateSessionsFromAgentRoot, 'function', 'real migrations module loaded');
	assert.equal(typeof session.loadEntriesFromFile, 'function', 'real session-manager module loaded');

	// A colliding destination written by the reader's own encoder, so both sides
	// must agree on where a legacy session is supposed to land.
	const betaDir = session.getDefaultSessionDir(projBeta, agentDir);
	const destination = write(
		path.join(betaDir, 'a-collide.jsonl'),
		`${JSON.stringify(header('dest-winner', projBeta))}\n${JSON.stringify(message('w1', 'winner body'))}\n`,
	);
	// Legacy sessions left directly in the agent root by the v0.30.0 bug.
	// Sorted readdir order: the collision is handled first, so the two files after
	// it prove that one collision does not abort the remaining migrations.
	const collidedSource = write(
		path.join(agentDir, 'a-collide.jsonl'),
		`${JSON.stringify(header('legacy-loser', projBeta))}\n${JSON.stringify(message('l1', 'legacy body'))}\n`,
	);
	const alphaSource = write(
		path.join(agentDir, 'b-legacy.jsonl'),
		`${JSON.stringify(header('legacy-alpha', projAlpha))}\n${JSON.stringify(message('l2', 'legacy alpha'))}\n`,
	);
	const laterSource = write(
		path.join(agentDir, 'c-legacy.jsonl'),
		`${JSON.stringify(header('legacy-later', projAlpha))}\n${JSON.stringify(message('l3', 'legacy later'))}\n`,
	);
	const strangerSource = write(path.join(agentDir, 'd-not-a-session.jsonl'), `${JSON.stringify({ hello: 'world' })}\n`);

	const destinationBefore = read(destination);
	const collidedBefore = read(collidedSource);
	const strangerBefore = read(strangerSource);

	// Producer: the migration runs once the destination already exists.
	// Consumer: the real session reader runs only after the migration signalled
	// completion, so the ordering is explicit instead of time dependent.
	const migrated = deferred();
	const producer = (async () => {
		migration.migrateSessionsFromAgentRoot();
		migrated.resolve();
	})();
	const consumer = (async () => {
		await migrated.promise;

		// 1. Existing destination bytes win, byte for byte.
		assert.equal(read(destination), destinationBefore, 'a collision must never overwrite the destination file');

		// 2. The legacy side of the collision is preserved at its original path.
		assert.ok(fs.existsSync(collidedSource), 'the colliding legacy session must stay in the agent root');
		assert.equal(read(collidedSource), collidedBefore, 'the colliding legacy session bytes must be preserved');
		assert.equal(
			JSON.stringify(ids(session.loadEntriesFromFile(collidedSource))),
			JSON.stringify(['legacy-loser', 'l1']),
			'the preserved legacy session is still readable',
		);

		// 3. Other migrations continue after the skip and land where the reader looks.
		const alphaDir = session.getDefaultSessionDir(projAlpha, agentDir);
		for (const [source, name, expected] of [
			[alphaSource, 'b-legacy.jsonl', ['legacy-alpha', 'l2']],
			[laterSource, 'c-legacy.jsonl', ['legacy-later', 'l3']],
		]) {
			assert.equal(fs.existsSync(source), false, `${name} should be migrated out of the agent root`);
			const target = path.join(alphaDir, name);
			assert.ok(fs.existsSync(target), `${name} should land in the session dir the reader computes`);
			assert.equal(
				JSON.stringify(ids(session.loadEntriesFromFile(target))),
				JSON.stringify(expected),
				`${name} is readable through the real session reader`,
			);
		}

		// 4. Cross-module discovery sees the winner, never the suppressed loser.
		assert.equal(
			session.SessionManager.findById(projBeta, 'dest-winner', betaDir),
			destination,
			'the surviving destination session is discoverable',
		);
		assert.equal(
			JSON.stringify(ids(session.loadEntriesFromFile(destination))),
			JSON.stringify(['dest-winner', 'w1']),
			'the destination session body is untouched',
		);
		assert.equal(
			session.SessionManager.findById(projBeta, 'legacy-loser', betaDir),
			undefined,
			'the suppressed collision must not be discoverable in the session dir',
		);
		assert.equal(
			session.SessionManager.findById(projAlpha, 'legacy-later', alphaDir),
			path.join(alphaDir, 'c-legacy.jsonl'),
			'migrated sessions are discoverable by id',
		);

		// 5. Non-session jsonl files are left alone.
		assert.equal(read(strangerSource), strangerBefore, 'a non-session jsonl file must not be touched');
	})();
	await Promise.all([producer, consumer]);
}

function checkReaderHeaderValidation(session) {
	// 1. A header missing a string id must be rejected before the newline repair.
	const missingId = write(
		path.join(readerDir, 'missing-id.jsonl'),
		`${JSON.stringify({ type: 'session', version: 3, timestamp: STAMP, cwd: projAlpha })}\n${JSON.stringify(message('m1', 'body'))}`,
	);
	const missingIdBefore = read(missingId);
	assert.equal(
		JSON.stringify(ids(session.loadEntriesFromFile(missingId))),
		'[]',
		'a session header without a string id must be rejected',
	);
	assert.equal(read(missingId), missingIdBefore, 'a rejected header must not be repaired or rewritten');

	// 2. A non-string id is just as invalid as a missing one.
	const numericId = write(
		path.join(readerDir, 'numeric-id.jsonl'),
		`${JSON.stringify({ type: 'session', version: 3, id: 42, timestamp: STAMP, cwd: projAlpha })}\n${JSON.stringify(message('m2', 'body'))}`,
	);
	const numericIdBefore = read(numericId);
	assert.equal(
		JSON.stringify(ids(session.loadEntriesFromFile(numericId))),
		'[]',
		'a session header with a non-string id must be rejected',
	);
	assert.equal(read(numericId), numericIdBefore, 'a rejected header must not be repaired or rewritten');

	// 3. A file whose first entry is not a session header must be rejected even
	//    though that entry carries a string id.
	const noHeader = write(
		path.join(readerDir, 'no-header.jsonl'),
		`${JSON.stringify(message('m3', 'first'))}\n${JSON.stringify(message('m4', 'second'))}`,
	);
	const noHeaderBefore = read(noHeader);
	assert.equal(
		JSON.stringify(ids(session.loadEntriesFromFile(noHeader))),
		'[]',
		'a file without a session header must be rejected',
	);
	assert.equal(read(noHeader), noHeaderBefore, 'a rejected file must not be repaired or rewritten');

	// 4. A valid header with an unterminated final record is still accepted, and
	//    the missing final newline is repaired exactly once.
	const validUnterminated = write(
		path.join(readerDir, 'valid-unterminated.jsonl'),
		`${JSON.stringify(header('s-valid', projAlpha))}\n${JSON.stringify(message('e1', 'hi'))}`,
	);
	const validUnterminatedBefore = read(validUnterminated);
	assert.equal(
		JSON.stringify(ids(session.loadEntriesFromFile(validUnterminated))),
		JSON.stringify(['s-valid', 'e1']),
		'a valid header with an unterminated final record is accepted',
	);
	assert.equal(
		read(validUnterminated),
		`${validUnterminatedBefore}\n`,
		'a valid unterminated final record is repaired with exactly one newline',
	);
	assert.equal(
		JSON.stringify(ids(session.loadEntriesFromFile(validUnterminated))),
		JSON.stringify(['s-valid', 'e1']),
		'repairing is idempotent',
	);
	assert.equal(read(validUnterminated), `${validUnterminatedBefore}\n`, 'a repaired file is not repaired twice');

	// 5. A valid, already terminated session file is not rewritten at all.
	const validTerminated = write(
		path.join(readerDir, 'valid-terminated.jsonl'),
		`${JSON.stringify(header('s-term', projAlpha))}\n${JSON.stringify(message('e2', 'yo'))}\n`,
	);
	const validTerminatedBefore = read(validTerminated);
	assert.equal(
		JSON.stringify(ids(session.loadEntriesFromFile(validTerminated))),
		JSON.stringify(['s-term', 'e2']),
		'a valid terminated session is accepted',
	);
	assert.equal(read(validTerminated), validTerminatedBefore, 'a valid terminated session is not rewritten');
}

function checkSessionManagerOpen(session) {
	// The open path consumes the reader: a rejected header must surface as an
	// error without touching the file, while a valid header still opens.
	const openInvalid = write(
		path.join(readerDir, 'open-invalid.jsonl'),
		`${JSON.stringify({ type: 'session', version: 3, timestamp: STAMP, cwd: projAlpha })}\n${JSON.stringify(message('m9', 'body'))}`,
	);
	const openInvalidBefore = read(openInvalid);
	assert.throws(
		() => session.SessionManager.open(openInvalid),
		/not a valid/,
		'opening a session whose header lacks a string id must fail',
	);
	assert.equal(read(openInvalid), openInvalidBefore, 'the rejected session file must not be rewritten');

	const openValid = write(
		path.join(readerDir, 'open-valid.jsonl'),
		`${JSON.stringify(header('s-open', projAlpha))}\n${JSON.stringify(message('e3', 'hello'))}\n`,
	);
	const openValidBefore = read(openValid);
	const manager = session.SessionManager.open(openValid);
	assert.equal(manager.getSessionId(), 's-open', 'a valid session header is accepted by SessionManager.open');
	assert.equal(manager.getEntries().length, 1, 'the valid session body is loaded');
	assert.equal(read(openValid), openValidBefore, 'opening a valid terminated session does not rewrite it');
}

try {
	prepareScratch();
	await checkMigrationsAndReader();
	const { session } = await createSessionPipeline(workspace, agentDir);
	checkReaderHeaderValidation(session);
	checkSessionManagerOpen(session);
	console.log('regression.mjs: all collision-safety and invalid-header checks passed');
} finally {
	fs.rmSync(scratch, { recursive: true, force: true });
}
