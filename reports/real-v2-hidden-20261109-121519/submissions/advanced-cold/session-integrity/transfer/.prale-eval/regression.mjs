/**
 * Regression coverage for the legacy session migration path contract.
 *
 * The legacy migration (packages/coding-agent/src/migrations.ts) and the session
 * reader (packages/coding-agent/src/core/session-manager.ts) must agree on one
 * observable layout contract: a cwd is turned into `--<path>--` under
 * `<agentDir>/sessions/`, where the leading separator is removed and every `/`,
 * `\` and `:` becomes `-` (see packages/coding-agent/docs/session-format.md).
 *
 * Every assertion goes through the real submitted modules: the real migration
 * moves real files, and the real reader (list / findById / open /
 * loadEntriesFromFile) has to find and parse them.
 *
 * Run: node --experimental-vm-modules .prale-eval/regression.mjs
 */
import { createSessionPipeline } from './subject.mjs';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const workspace = process.cwd();
const sandbox = path.join(workspace, '.prale-eval', '.tmp-regression');
const agentDir = path.join(sandbox, 'agent');
const sessionsRoot = path.join(agentDir, 'sessions');

/** Absolute POSIX cwd mixing separators, a Windows-style fragment, a colon and Unicode. */
const ODD_CWD = '/tmp/pi project/win\\C:\\Users\\me:data/\u00e9t\u00e9/\u65e5\u672c';
/** Plain POSIX cwd used for the collision/characterisation part of the contract. */
const PLAIN_CWD = '/x';
/** Two different cwds that the (intentionally lossy) encoding maps onto one directory. */
const LOSSY_A = '/srv/app';
const LOSSY_B = '/srv-app';
/** Non-canonical spelling of an absolute POSIX cwd that the reader resolves first. */
const UNNORMALIZED_CWD = '/data/proj/./sub/';
const NORMALIZED_CWD = '/data/proj/sub';

/**
 * Independent statement of the documented layout contract. If either production
 * module drifts from it, the derived directory stops matching the reader's lookup
 * (or the migration's destination), and the assertions below fail.
 */
function expectedDirName(cwd) {
	return `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}
function expectedSessionDir(cwd) {
	// The reader resolves the cwd before encoding it, so the contract applies to
	// the resolved path (`/a/./b/` and `/a/b` therefore share one directory).
	return path.join(sessionsRoot, expectedDirName(path.resolve(cwd)));
}

const sessionLines = (cwd, id, texts) => [
	JSON.stringify({ type: 'session', version: 3, id, timestamp: '2025-01-01T00:00:00.000Z', cwd }),
	...texts.map((text, index) =>
		JSON.stringify({
			type: 'message',
			id: `${index}${'abcdef'.slice(0, 7)}`,
			parentId: index === 0 ? null : `${index - 1}${'abcdef'.slice(0, 7)}`,
			timestamp: `2025-01-01T00:00:0${index + 1}.000Z`,
			message: { role: index % 2 === 0 ? 'user' : 'assistant', content: text, timestamp: index + 1 },
		}),
	),
];

function writeLegacySession(fileName, cwd, id, texts) {
	const content = `${sessionLines(cwd, id, texts).join('\n')}\n`;
	const filePath = path.join(agentDir, fileName);
	fs.writeFileSync(filePath, content, 'utf8');
	return { filePath, content };
}

function jsonlFiles(dir) {
	return fs.existsSync(dir) ? fs.readdirSync(dir).filter((entry) => entry.endsWith('.jsonl')).sort() : [];
}

async function main() {
	fs.rmSync(sandbox, { recursive: true, force: true });
	fs.mkdirSync(agentDir, { recursive: true });

	try {
		const pipeline = await createSessionPipeline(workspace, agentDir);
		const { migration, session } = pipeline;
		assert.equal(typeof migration.migrateSessionsFromAgentRoot, 'function');

		// --- Reader-side lookup contract for the shared encoding ------------------
		// The canonical directory must follow the documented rule, not a local variant.
		assert.equal(
			session.getDefaultSessionDir(ODD_CWD, agentDir),
			expectedSessionDir(ODD_CWD),
			'session reader must encode `/`, `\\` and `:` alike and resolve the leading separator',
		);
		assert.equal(session.getDefaultSessionDir(PLAIN_CWD, agentDir), expectedSessionDir(PLAIN_CWD));
		assert.equal(session.getDefaultSessionDir(UNNORMALIZED_CWD, agentDir), expectedSessionDir(NORMALIZED_CWD));

		// --- Fixtures: legacy sessions sitting directly in the agent root ---------
		const odd = writeLegacySession('session-a.jsonl', ODD_CWD, 'session-a', [
			'hello \u00e9t\u00e9 \u65e5\u672c',
			'second entry',
		]);

		// Collision: the destination file already exists with other content.
		const collisionDir = expectedSessionDir(PLAIN_CWD);
		fs.mkdirSync(collisionDir, { recursive: true });
		const collisionTarget = path.join(collisionDir, 'session-b.jsonl');
		const collisionContent = `${sessionLines(PLAIN_CWD, 'session-b', ['already migrated']).join('\n')}\n`;
		fs.writeFileSync(collisionTarget, collisionContent, 'utf8');
		writeLegacySession('session-b.jsonl', PLAIN_CWD, 'session-b', ['collision must not overwrite']);
		// A second file for the same cwd has no target yet and must still migrate.
		const plain = writeLegacySession('session-b2.jsonl', PLAIN_CWD, 'session-b2', ['same cwd, free name']);

		// Malformed line after a valid header: skipped by the reader, bytes preserved.
		const malformedLines = [
			JSON.stringify({ type: 'session', version: 3, id: 'session-c', timestamp: '2025-01-01T00:00:00.000Z', cwd: LOSSY_A }),
			'{ this is not json',
			JSON.stringify({
				type: 'message',
				id: 'aaaaaaa1',
				parentId: null,
				timestamp: '2025-01-01T00:00:01.000Z',
				message: { role: 'user', content: 'survives malformed neighbour', timestamp: 1 },
			}),
		];
		const malformed = { filePath: path.join(agentDir, 'session-c.jsonl'), content: `${malformedLines.join('\n')}\n` };
		fs.writeFileSync(malformed.filePath, malformed.content, 'utf8');

		// Two distinct cwds share one encoded directory.
		const lossyB = writeLegacySession('session-d.jsonl', LOSSY_B, 'session-d', ['lossy sibling']);

		// A legacy header may spell the cwd differently from the reader's lookup.
		const unnormalized = writeLegacySession('session-e.jsonl', UNNORMALIZED_CWD, 'session-e', ['resolved cwd']);

		assert.deepEqual(jsonlFiles(agentDir), [
			'session-a.jsonl',
			'session-b.jsonl',
			'session-b2.jsonl',
			'session-c.jsonl',
			'session-d.jsonl',
			'session-e.jsonl',
		]);

		// --- Run the real migration ----------------------------------------------
		migration.migrateSessionsFromAgentRoot();

		// 1. The migrated file is where the reader looks.
		const oddTarget = path.join(expectedSessionDir(ODD_CWD), 'session-a.jsonl');
		assert.equal(fs.existsSync(oddTarget), true, 'migrated session must land in the canonical lookup directory');
		assert.equal(fs.existsSync(odd.filePath), false, 'migrated session must leave the agent root');
		assert.equal(fs.readFileSync(oddTarget).equals(Buffer.from(odd.content, 'utf8')), true, 'bytes must be preserved');

		// 2. The real reader finds it for the original cwd.
		const listed = await session.SessionManager.list(ODD_CWD);
		assert.deepEqual(
			Array.from(listed, (info) => info.id),
			['session-a'],
			'the session reader must discover the migrated session for its cwd',
		);
		assert.equal(listed[0].path, oddTarget);
		assert.equal(listed[0].cwd, ODD_CWD, 'the reader must report the header cwd verbatim');
		assert.equal(session.SessionManager.findById(ODD_CWD, 'session-a'), oddTarget);

		// 3. Entry order, Unicode and the header cwd survive through the real reader.
		const entries = session.loadEntriesFromFile(oddTarget);
		assert.deepEqual(
			Array.from(entries, (entry) => (entry.type === 'session' ? 'header' : entry.id)),
			['header', '0abcdef', '1abcdef'],
			'entry order must be preserved',
		);
		assert.equal(entries[0].cwd, ODD_CWD, 'header cwd must be preserved verbatim');
		assert.deepEqual(entries[1].message.content, 'hello \u00e9t\u00e9 \u65e5\u672c');
		assert.deepEqual(entries[2].message.content, 'second entry');

		const opened = session.SessionManager.open(oddTarget);
		assert.equal(opened.getCwd(), path.resolve(ODD_CWD));
		assert.deepEqual(Array.from(opened.getEntries(), (entry) => entry.id), ['0abcdef', '1abcdef']);
		assert.deepEqual(Array.from(opened.buildSessionContext().messages, (message) => message.content), [
			'hello \u00e9t\u00e9 \u65e5\u672c',
			'second entry',
		]);

		// 4. Malformed lines are skipped, everything else is still readable.
		const malformedTarget = path.join(expectedSessionDir(LOSSY_A), 'session-c.jsonl');
		assert.equal(fs.existsSync(malformedTarget), true);
		assert.equal(fs.readFileSync(malformedTarget).equals(Buffer.from(malformed.content, 'utf8')), true);
		assert.deepEqual(
			Array.from(session.loadEntriesFromFile(malformedTarget), (entry) => (entry.type === 'session' ? 'header' : entry.id)),
			['header', 'aaaaaaa1'],
		);

		// 5. Collisions never overwrite data, and migration keeps going.
		assert.equal(fs.readFileSync(collisionTarget, 'utf8'), collisionContent, 'existing session bytes must not be overwritten');
		assert.equal(fs.existsSync(path.join(agentDir, 'session-b.jsonl')), true, 'collided source must not be lost');
		const plainTarget = path.join(expectedSessionDir(PLAIN_CWD), 'session-b2.jsonl');
		assert.equal(fs.existsSync(plainTarget), true, 'a free file name for the same cwd must still migrate');
		assert.equal(fs.readFileSync(plainTarget).equals(Buffer.from(plain.content, 'utf8')), true);

		// 6. Distinct cwds sharing an encoded directory keep their own data.
		const lossyTarget = path.join(expectedSessionDir(LOSSY_B), 'session-d.jsonl');
		assert.equal(lossyTarget, path.join(expectedSessionDir(LOSSY_A), 'session-d.jsonl'));
		assert.equal(fs.existsSync(lossyTarget), true);
		assert.equal(fs.readFileSync(lossyTarget).equals(Buffer.from(lossyB.content, 'utf8')), true);

		// 7. Non-canonical cwd spellings reach the same reader lookup path.
		const unnormalizedTarget = path.join(expectedSessionDir(NORMALIZED_CWD), 'session-e.jsonl');
		assert.equal(unnormalizedTarget, path.join(expectedSessionDir(UNNORMALIZED_CWD), 'session-e.jsonl'));
		assert.equal(fs.existsSync(unnormalizedTarget), true, 'migrated file must follow the resolved cwd');
		assert.equal(fs.readFileSync(unnormalizedTarget).equals(Buffer.from(unnormalized.content, 'utf8')), true);
		assert.deepEqual(
			Array.from(await session.SessionManager.list(NORMALIZED_CWD), (info) => info.id),
			['session-e'],
		);

		// 8. Repeated migration is safe: no duplication, no data churn.
		const snapshot = () => ({
			root: jsonlFiles(agentDir),
			canonical: fs.readdirSync(sessionsRoot, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => [entry.name, jsonlFiles(path.join(sessionsRoot, entry.name))])
				.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)),
			collision: fs.readFileSync(collisionTarget, 'utf8'),
			odd: fs.readFileSync(oddTarget).toString('base64'),
		});
		const afterFirstRun = snapshot();
		migration.migrateSessionsFromAgentRoot();
		migration.migrateSessionsFromAgentRoot();
		assert.deepEqual(snapshot(), afterFirstRun, 'repeated migration must be idempotent');

		assert.deepEqual(jsonlFiles(agentDir), ['session-b.jsonl'], 'only the collided legacy file may stay behind');
		assert.deepEqual(jsonlFiles(expectedSessionDir(ODD_CWD)), ['session-a.jsonl']);
		assert.deepEqual(jsonlFiles(sessionsRoot).length, 0, 'sessions root itself must not collect stray files');
		assert.deepEqual(Array.from(await session.SessionManager.list(ODD_CWD), (info) => info.id), ['session-a']);

		console.log('session-integrity/transfer regression: ok');
	} finally {
		fs.rmSync(sandbox, { recursive: true, force: true });
	}
}

await main();
