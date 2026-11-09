/** Hidden executable contracts. Never copied to an agent workspace. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { loadMigrations, createTrustSubject, createRecoverySubject } from './subject.mjs';

const [root, episode] = process.argv.slice(2);
const plain = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
let checks = 0;
async function check(name, fn) {
  try { await fn(); checks++; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
}

async function trust() {
  for (const initialTrusted of [false, true]) {
    await check(`bootstrap initial=${initialTrusted}`, async () => {
      const { loader, state, events } = await createTrustSubject(root, { initialTrusted });
      const result = await loader.loadProjectTrustExtensions();
      assert.equal(state.trusted, false);
      assert.deepEqual(plain(events.slice(0, 3)), [['set', false], ['settings', false], ['resolve', false]]);
      assert.deepEqual(plain(result.extensions.map((e) => basename(e.path)).sort()), ['cli.ts', 'user.ts']);
    });
    for (const decision of [false, true]) {
      await check(`reload initial=${initialTrusted} decision=${decision}`, async () => {
        const { loader, events, state } = await createTrustSubject(root, { initialTrusted });
        let decisions = 0;
        await loader.reload({ resolveProjectTrust: async ({ extensionsResult }) => {
          decisions++;
          assert.equal(state.loadedTrust, false, 'decision must follow untrusted settings reload');
          assert.deepEqual(plain(extensionsResult.extensions.map((e) => basename(e.path)).sort()), ['cli.ts', 'user.ts']);
          events.push(['decision-start']);
          await new Promise((resolve) => setTimeout(resolve, 1));
          events.push(['decision-end']);
          return decision;
        } });
        assert.equal(decisions, 1, 'resolver must run exactly once');
        assert.equal(state.trusted, decision);
        assert.deepEqual(plain(loader.getExtensions().extensions.map((e) => basename(e.path)).sort()),
          decision ? ['cli.ts', 'project.ts', 'user.ts'] : ['cli.ts', 'user.ts']);
        const end = events.findIndex((e) => e[0] === 'decision-end');
        assert.deepEqual(plain(events.slice(end + 1, end + 4)), [['set', decision], ['settings', decision], ['resolve', decision]]);
        // A following denied reload must not retain a previous approval.
        await loader.reload({ resolveProjectTrust: async () => false });
        assert.equal(state.trusted, false);
        assert.equal(loader.getExtensions().extensions.some((e) => basename(e.path) === 'project.ts'), false);
      });
    }
  }
  await check('resolver rejection leaves an untrusted boundary', async () => {
    const { loader, state, events } = await createTrustSubject(root);
    await assert.rejects(loader.reload({ resolveProjectTrust: async () => {
      throw new Error('trust decision unavailable');
    } }), /trust decision unavailable/);
    assert.equal(state.trusted, false);
    assert.equal(events.filter((event) => event[0] === 'resolve').length, 1);
  });
  for (const initialTrusted of [false, true]) {
    await check(`reload without resolver preserves trust=${initialTrusted}`, async () => {
      const { loader, state } = await createTrustSubject(root, { initialTrusted });
      await loader.reload();
      assert.equal(state.trusted, initialTrusted);
      assert.equal(loader.getExtensions().extensions.some((e) => basename(e.path) === 'project.ts'), initialTrusted);
    });
  }
}

async function migration() {
  async function fixture(name, fn) {
    await check(name, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'real-v2-migration-'));
      try { await fn(dir, await loadMigrations(root, dir)); }
      finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
  for (const bom of ['', '\uFEFF']) {
    await fixture(`oauth bom=${Boolean(bom)}`, async (dir, subject) => {
      const oauth = join(dir, 'oauth.json');
      writeFileSync(oauth, bom + JSON.stringify({ provider: { access: 'token', refresh: 'refresh' } }));
      writeFileSync(join(dir, 'settings.json'), '\uFEFF' + JSON.stringify({ keep: 7, apiKeys: { provider: 'loser', other: 'key' } }));
      assert.deepEqual([...subject.migrateAuthToAuthJson()].sort(), ['other', 'provider']);
      assert.deepEqual(JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8')), {
        provider: { type: 'oauth', access: 'token', refresh: 'refresh' }, other: { type: 'api_key', key: 'key' },
      });
      assert.equal(existsSync(oauth), false);
      assert.equal(existsSync(`${oauth}.migrated`), true);
      assert.deepEqual(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')), { keep: 7 });
      const first = readFileSync(join(dir, 'auth.json'), 'utf8');
      assert.equal(subject.migrateAuthToAuthJson().length, 0);
      assert.equal(readFileSync(join(dir, 'auth.json'), 'utf8'), first);
    });
  }
  await fixture('existing auth and malformed oauth are preserved', async (dir, subject) => {
    writeFileSync(join(dir, 'oauth.json'), '\uFEFF{not-json');
    assert.equal(subject.migrateAuthToAuthJson().length, 0);
    assert.equal(readFileSync(join(dir, 'oauth.json'), 'utf8'), '\uFEFF{not-json');
    assert.equal(existsSync(join(dir, 'oauth.json.migrated')), false);
    writeFileSync(join(dir, 'auth.json'), '{"keep":true}');
    writeFileSync(join(dir, 'oauth.json'), '{"provider":{"access":"new"}}');
    assert.equal(subject.migrateAuthToAuthJson().length, 0);
    assert.equal(readFileSync(join(dir, 'auth.json'), 'utf8'), '{"keep":true}');
    assert.equal(existsSync(join(dir, 'oauth.json')), true);
  });
  for (const [cwd, encoded] of [
    ['/home/user/work', '--home-user-work--'],
    ['C:\\Users\\dev\\repo', '--C--Users-dev-repo--'],
    ['\\\\server\\share\\repo', '---server-share-repo--'],
  ]) {
    await fixture(`session path ${cwd}`, async (dir, subject) => {
      const content = JSON.stringify({ type: 'session', cwd }) + '\n{"type":"message","text":"untouched"}\n';
      writeFileSync(join(dir, 'legacy.jsonl'), content);
      writeFileSync(join(dir, 'invalid.jsonl'), 'not json\n');
      writeFileSync(join(dir, 'wrong-type.jsonl'), '{"type":"message","cwd":"/wrong"}\n');
      subject.migrateSessionsFromAgentRoot();
      const destination = join(dir, 'sessions', encoded, 'legacy.jsonl');
      assert.equal(existsSync(destination), true, `expected canonical destination ${encoded}`);
      assert.equal(readFileSync(destination, 'utf8'), content);
      assert.equal(existsSync(join(dir, 'legacy.jsonl')), false);
      assert.equal(readFileSync(join(dir, 'invalid.jsonl'), 'utf8'), 'not json\n');
      assert.equal(existsSync(join(dir, 'wrong-type.jsonl')), true);
      subject.migrateSessionsFromAgentRoot();
      assert.equal(readFileSync(destination, 'utf8'), content);
    });
  }
  await fixture('collision preserves both copies and continues batch', async (dir, subject) => {
    const destination = join(dir, 'sessions', '--work--');
    mkdirSync(destination, { recursive: true });
    const collision = '{"type":"session","cwd":"/work"}\nlegacy';
    const next = '{"type":"session","cwd":"/work"}\nnext';
    writeFileSync(join(dir, 'a-collision.jsonl'), collision);
    writeFileSync(join(destination, 'a-collision.jsonl'), 'existing destination bytes');
    writeFileSync(join(dir, 'z-next.jsonl'), next);
    assert.deepEqual(readdirSync(dir).filter((p) => p.endsWith('.jsonl')), ['a-collision.jsonl', 'z-next.jsonl']);
    subject.migrateSessionsFromAgentRoot();
    assert.equal(readFileSync(join(destination, 'a-collision.jsonl'), 'utf8'), 'existing destination bytes');
    assert.equal(readFileSync(join(dir, 'a-collision.jsonl'), 'utf8'), collision);
    assert.equal(existsSync(join(destination, 'z-next.jsonl')), true, 'collision must not abort remaining files');
    assert.equal(readFileSync(join(destination, 'z-next.jsonl'), 'utf8'), next);
    assert.equal(existsSync(join(dir, 'z-next.jsonl')), false);
    subject.migrateSessionsFromAgentRoot();
    assert.equal(readFileSync(join(destination, 'a-collision.jsonl'), 'utf8'), 'existing destination bytes');
  });
}

async function recovery() {
  const run = await createRecoverySubject(root);
  for (const persisted of ['safe', 'never', undefined]) {
    for (const declared of ['safe', 'never', undefined, null]) {
      for (const cancelled of [false, true]) {
        await check(`replay persisted=${persisted} declared=${declared} cancelled=${cancelled}`, async () => {
          const result = await run(persisted, declared, cancelled);
          const allowed = persisted === 'safe' && declared === 'safe' && !cancelled;
          if (allowed) {
            assert.deepEqual(result.events, ['clear', 'invoke', 'effect-complete', 'publish']);
            assert.deepEqual(plain(result.outcome.args), { persisted: 42 });
            assert.equal(result.outcome.recovery, true);
            assert.equal(result.outcome.message.isError, false);
          } else {
            assert.deepEqual(result.events, ['read', 'publish']);
            assert.equal(result.outcome.message.isError, true);
            assert.equal(result.outcome.message.content[0].text, 'durable-progress');
            assert.deepEqual(plain(result.outcome.message.details), { step: 2 });
            assert.match(result.outcome.message.content.at(-1).text, /interrupted/i);
          }
        });
      }
    }
  }
  await check('publication waits for asynchronous effect', async () => {
    let release;
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    const wait = new Promise((resolve) => { release = resolve; });
    let finished = false;
    const pending = run('safe', 'safe', false, { effect: () => { entered(); return wait; } }).then((value) => { finished = true; return value; });
    await started;
    assert.equal(finished, false);
    release();
    const result = await pending;
    assert.deepEqual(result.events, ['clear', 'invoke', 'effect-complete', 'publish']);
  });
}

try {
  const suite = { 'extension-trust': trust, 'session-migration': migration, 'tool-recovery-order': recovery }[episode];
  assert.ok(suite, `unknown episode: ${episode}`);
  await suite();
  console.log(JSON.stringify({ status: 'passed', checks }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
