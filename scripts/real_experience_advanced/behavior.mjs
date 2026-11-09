/** Hidden multi-module behavior contracts. No wall-clock or random assertions. */
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createResourcePipeline, createSessionPipeline, createExecutionPipeline } from './subject.mjs';

const [root, episode] = process.argv.slice(2);
const plain = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
let checks = 0;
async function check(name, fn) {
  try { await fn(); checks++; console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); throw error; }
}
function ordered(events, names) {
  const positions = names.map((name) => {
    assert.equal(events.filter((event) => event === name).length, 1, `expected exactly one ${name}`);
    return events.indexOf(name);
  });
  for (let i = 1; i < positions.length; i++) assert.ok(positions[i - 1] < positions[i], names.join(' -> '));
}

async function resource() {
  await check('untrusted bootstrap uses actual SettingsManager storage boundary', async () => {
    const p = await createResourcePipeline(root);
    p.events.length = 0;
    const bootstrap = await p.loader.loadProjectTrustExtensions();
    assert.deepEqual(plain(bootstrap.extensions.map((e) => basename(e.path)).sort()), ['cli.ts', 'global.ts']);
    assert.equal(p.settings.isProjectTrusted(), false);
    assert.deepEqual(plain(p.settings.getProjectSettings()), {});
    assert.equal(p.settings.getDefaultModel(), 'global-model');
    assert.equal(p.events.some((event) => event[0] === 'storage' && event[1] === 'project'), false,
      'bootstrap must not even read untrusted project settings');
  });
  for (const override of [false, true]) {
    await check(`explicit override=${override} traverses resolver and loader`, async () => {
      const p = await createResourcePipeline(root);
      p.scenario.override = override; p.scenario.policy = 'always';
      const result = await p.reload();
      assert.equal(result.calls, 1);
      assert.deepEqual(plain(result.names.sort()), override ? ['cli.ts', 'global.ts', 'project.ts'] : ['cli.ts', 'global.ts']);
      assert.equal(p.settings.getDefaultModel(), override ? 'project-model' : 'global-model');
      assert.equal(p.settings.getCompactionSettings().reserveTokens, override ? 4096 : 8192);
      assert.equal(p.settings.getCompactionSettings().keepRecentTokens, 2000);
      assert.equal(p.events.some((e) => e[0] === 'extension-decision'), false, 'override must bypass extensions/UI');
    });
  }
  for (const policy of ['always', 'never']) {
    await check(`default policy=${policy} without override or stored consent`, async () => {
      const p = await createResourcePipeline(root);
      p.scenario.policy = policy;
      const result = await p.reload();
      assert.equal(result.calls, 1);
      assert.equal(result.names.includes('project.ts'), policy === 'always');
      assert.equal(p.settings.isProjectTrusted(), policy === 'always');
      assert.equal(p.consentWrites.length, 0);
    });
  }
  for (const stored of [false, true]) {
    await check(`stored decision=${stored} dominates default policy`, async () => {
      const p = await createResourcePipeline(root);
      p.scenario.stored = stored; p.scenario.policy = stored ? 'never' : 'always';
      assert.equal(await p.resolve(), stored);
      const result = await p.reload();
      assert.equal(result.names.includes('project.ts'), stored);
    });
  }
  for (const trusted of ['yes', 'no']) for (const remember of [undefined, false, true]) {
    await check(`extension decision ${trusted} remember=${remember}`, async () => {
      const p = await createResourcePipeline(root);
      p.scenario.extension = { trusted, remember };
      const result = await p.reload();
      assert.equal(result.names.includes('project.ts'), trusted === 'yes');
      assert.equal(p.consentWrites.length, remember === true ? 1 : 0);
      if (remember === true) assert.equal(p.consentWrites[0][1], trusted === 'yes');
    });
  }
  await check('headless deny and revocation clear real cached project settings', async () => {
    const p = await createResourcePipeline(root);
    assert.equal(await p.resolve(), false);
    p.scenario.override = true;
    await p.reload();
    assert.equal(p.settings.getDefaultModel(), 'project-model');
    p.settings.setProjectTrusted(false);
    assert.deepEqual(plain(p.settings.getProjectSettings()), {});
    assert.equal(p.settings.getDefaultModel(), 'global-model');
    p.scenario.override = undefined;
    const result = await p.reload();
    assert.deepEqual(plain(result.names.sort()), ['cli.ts', 'global.ts']);
    assert.deepEqual(JSON.parse(p.storageData.global), {
      defaultModel: 'global-model', extensions: ['global'], compaction: { reserveTokens: 8192, keepRecentTokens: 2000 },
    });
  });
  await check('UI approval is session-local and no-resolver reload retains state', async () => {
    const p = await createResourcePipeline(root);
    p.scenario.hasUI = true;
    await p.reload();
    assert.equal(p.settings.isProjectTrusted(), true);
    assert.equal(p.consentWrites.length, 0);
    await p.loader.reload();
    assert.equal(p.settings.isProjectTrusted(), true);
    assert.equal(p.loader.getExtensions().extensions.some((e) => basename(e.path) === 'project.ts'), true);
  });
}

async function session() {
  async function fixture(name, fn) {
    await check(name, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'advanced-session-'));
      try { await fn(dir, await createSessionPipeline(root, dir)); }
      finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }
  await fixture('text normalization and migration preserve OAuth precedence', async (dir, p) => {
    assert.equal(p.text.stripBom('\uFEFFabc'), 'abc');
    assert.equal(p.text.stripBom('a\uFEFFb'), 'a\uFEFFb');
    assert.equal(p.text.stripBom('abc'), 'abc');
    writeFileSync(join(dir, 'oauth.json'), '\uFEFF' + JSON.stringify({ alpha: { access: 'oauth', refresh: 'refresh' } }));
    writeFileSync(join(dir, 'settings.json'), '\uFEFF' + JSON.stringify({ keep: 8, apiKeys: { alpha: 'fallback', beta: 'key' } }));
    assert.deepEqual([...p.migration.migrateAuthToAuthJson()].sort(), ['alpha', 'beta']);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8')), {
      alpha: { type: 'oauth', access: 'oauth', refresh: 'refresh' }, beta: { type: 'api_key', key: 'key' },
    });
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')), { keep: 8 });
    assert.equal(existsSync(join(dir, 'oauth.json.migrated')), true);
    assert.equal(p.migration.migrateAuthToAuthJson().length, 0);
  });
  await fixture('invalid credentials and existing auth remain untouched', async (dir, p) => {
    writeFileSync(join(dir, 'oauth.json'), '\uFEFF{broken');
    assert.equal(p.migration.migrateAuthToAuthJson().length, 0);
    assert.equal(readFileSync(join(dir, 'oauth.json'), 'utf8'), '\uFEFF{broken');
    writeFileSync(join(dir, 'auth.json'), '{"keep":true}');
    writeFileSync(join(dir, 'oauth.json'), '{"alpha":{"access":"new"}}');
    assert.equal(p.migration.migrateAuthToAuthJson().length, 0);
    assert.equal(readFileSync(join(dir, 'auth.json'), 'utf8'), '{"keep":true}');
    assert.equal(existsSync(join(dir, 'oauth.json')), true);
  });
  for (const cwd of ['/work/project', '/work/drive:C\\Users\\dev', '/work/\\\\server\\share:repo']) {
    await fixture(`migration output is readable at canonical path: ${cwd}`, async (dir, p) => {
      const records = [{ type: 'session', id: 'fixed-id', version: 3, cwd },
        { type: 'message', id: 'm1', parentId: null, message: { role: 'user', content: '中文 🧪' } },
        { type: 'message', id: 'm2', parentId: 'm1', message: { role: 'user', content: 'tail' } }];
      const content = records.map((record) => JSON.stringify(record)).join('\n');
      writeFileSync(join(dir, 'legacy.jsonl'), content);
      p.migration.migrateSessionsFromAgentRoot();
      const expectedName = '--' + cwd.slice(1).split(/[\\/:]/).join('-') + '--';
      const destination = p.session.getDefaultSessionDir(cwd, dir);
      assert.equal(basename(destination), expectedName);
      const file = join(destination, 'legacy.jsonl');
      assert.equal(existsSync(file), true, 'migration and reader must agree on destination');
      assert.equal(readFileSync(file, 'utf8'), content);
      assert.deepEqual(plain(p.session.loadEntriesFromFile(file)), records);
      assert.equal(readFileSync(file, 'utf8'), content + '\n');
      assert.deepEqual(plain(p.session.loadEntriesFromFile(file)), records);
      p.migration.migrateSessionsFromAgentRoot();
      assert.equal(readFileSync(file, 'utf8'), content + '\n');
    });
  }
  await fixture('collision continuation and invalid-header repair safety', async (dir, p) => {
    const cwd = '/work/mixed';
    const destination = p.session.getDefaultSessionDir(cwd, dir);
    const collision = JSON.stringify({ type: 'session', id: 'old', cwd });
    const records = [{ type: 'session', id: 'tail-session', cwd }, { type: 'message', id: 'last', text: '尾部 🧪' }];
    const tail = records.map((row) => JSON.stringify(row)).join('\n');
    writeFileSync(join(dir, 'a-collision.jsonl'), collision);
    writeFileSync(join(destination, 'a-collision.jsonl'), 'existing bytes');
    writeFileSync(join(dir, 'z-tail.jsonl'), tail);
    p.migration.migrateSessionsFromAgentRoot();
    assert.equal(readFileSync(join(destination, 'a-collision.jsonl'), 'utf8'), 'existing bytes');
    assert.equal(existsSync(join(dir, 'a-collision.jsonl')), true);
    assert.equal(readFileSync(join(dir, 'a-collision.jsonl'), 'utf8'), collision);
    assert.equal(existsSync(join(destination, 'z-tail.jsonl')), true);
    assert.deepEqual(plain(p.session.loadEntriesFromFile(join(destination, 'z-tail.jsonl'))), records);
    for (const invalid of [{ type: 'session', cwd }, { type: 'message', id: 'not-header' }, { type: 'session', id: 9 }]) {
      const file = join(destination, 'invalid.jsonl');
      const bytes = JSON.stringify(invalid);
      writeFileSync(file, bytes);
      assert.deepEqual(plain(p.session.loadEntriesFromFile(file)), []);
      assert.equal(readFileSync(file, 'utf8'), bytes, 'invalid header must not trigger newline repair');
    }
    const malformed = join(destination, 'malformed.jsonl');
    writeFileSync(malformed, JSON.stringify(records[0]) + '\nnot-json\n' + JSON.stringify(records[1]));
    assert.deepEqual(plain(p.session.loadEntriesFromFile(malformed)), records);
    p.migration.migrateSessionsFromAgentRoot();
    assert.equal(readFileSync(join(destination, 'a-collision.jsonl'), 'utf8'), 'existing bytes');
    assert.equal(readFileSync(join(dir, 'a-collision.jsonl'), 'utf8'), collision);
    assert.deepEqual(plain(p.session.loadEntriesFromFile(join(destination, 'z-tail.jsonl'))), records);
  });
  await fixture('UTF-8 decoder preserves a record crossing the fixed read buffer', async (dir, p) => {
    const header = { type: 'session', id: 'large-session', cwd: '/work/large' };
    const headerLine = JSON.stringify(header) + '\n';
    const prefix = JSON.stringify({ type: 'message', id: 'large-message', text: '' }).slice(0, -2);
    const fill = 1024 * 1024 - Buffer.byteLength(headerLine) - Buffer.byteLength(prefix) - 1;
    const message = { type: 'message', id: 'large-message', text: 'x'.repeat(fill) + '中文🧪'.repeat(100) };
    const file = join(dir, 'large.jsonl');
    const bytes = headerLine + JSON.stringify(message);
    assert.equal(Buffer.from(bytes)[1024 * 1024 - 1], 0xe4, 'fixture must split a UTF-8 character at the buffer edge');
    writeFileSync(file, bytes);
    const records = p.session.loadEntriesFromFile(file);
    assert.equal(records.length, 2);
    assert.equal(records[1].text, message.text);
    assert.equal(readFileSync(file, 'utf8'), bytes + '\n');
  });
}

async function execution() {
  const p = await createExecutionPipeline(root);
  for (const persisted of ['safe', 'never', undefined, null]) for (const declared of ['safe', 'never', undefined, null]) {
    for (const cancelled of [false, true]) {
      await check(`recovery admission ${persisted}/${declared}/${cancelled}`, async () => {
        const result = await p.run({ persisted, declared, cancelled });
        const allowed = persisted === 'safe' && declared === 'safe' && !cancelled;
        assert.equal(result.events.includes('invoke'), allowed);
        assert.equal(result.events.filter((event) => event === 'publish').length, 1);
        if (allowed) {
          assert.equal(result.outcome.message.content[0].text, 'persisted-arguments');
          assert.equal(result.outcome.message.isError, false);
          assert.deepEqual(plain(result.outcome.message.usage), { output: 3 });
          ordered(result.events, ['clear', 'invoke', 'effect-complete', 'seal', 'drain', 'drain-complete', 'publish']);
        } else {
          assert.deepEqual(result.events, ['read', 'publish']);
          assert.equal(result.outcome.message.isError, true);
          assert.equal(result.outcome.message.content[0].text, 'checkpoint-evidence');
          assert.deepEqual(plain(result.outcome.message.details), { step: 2 });
          assert.match(result.outcome.message.content.at(-1).text, /interrupted/i);
        }
      });
    }
  }
  await check('gate rejects aborting and closed admission without external effects', async () => {
    for (const status of ['aborting', 'closed']) {
      const { gate, control } = p.gate.createGate();
      const terminal = new Error('terminal');
      if (status === 'aborting') control.beginAbort(Promise.resolve());
      else control.close(terminal);
      let count = 0;
      assert.throws(() => gate.admit(() => count++));
      assert.equal(count, 0);
    }
  });
  await check('abort signal reaches admitted execution and closes future admission', async () => {
    let before, after;
    const result = await p.run({ effect: async ({ context, control }) => {
      before = context.abortSignal.aborted;
      control.beginAbort(Promise.resolve()); control.signalAbort();
      after = context.abortSignal.aborted;
      return { content: [{ type: 'text', text: 'aborted effect observed' }] };
    } });
    assert.equal(before, false);
    assert.equal(after, true);
    assert.equal(result.context.abortSignal.aborted, true);
    assert.throws(() => result.gate.admit(() => {}));
  });
  await check('live updates are not checkpoints and tool throws remain errors', async () => {
    const result = await p.run({ effect: async ({ update }) => {
      update({ content: [{ type: 'text', text: 'live' }] });
      update({ content: [{ type: 'text', text: 'explicit-live' }] }, { checkpoint: false });
      update({ content: [{ type: 'text', text: 'durable' }] }, { checkpoint: true });
      throw new Error('fixture failure');
    } });
    assert.equal(result.updates.length, 3);
    assert.equal(result.checkpoints.length, 1);
    assert.equal(result.checkpoints[0].content[0].text, 'durable');
    assert.equal(result.outcome.message.isError, true);
    assert.match(result.outcome.message.content[0].text, /fixture failure/);
    ordered(result.events, ['drain', 'drain-complete', 'publish']);
  });
  await check('explicit false and empty after-tool patches override while preserving usage', async () => {
    const result = await p.run({ effect: async () => { throw new Error('recoverable'); },
      patch: { isError: false, content: [], details: { recovered: true }, usage: { output: 7 } } });
    assert.equal(result.outcome.message.isError, false);
    assert.deepEqual(plain(result.outcome.message.content), []);
    assert.deepEqual(plain(result.outcome.message.details), { recovered: true });
    assert.deepEqual(plain(result.outcome.message.usage), { output: 7 });
    const inherited = await p.run({ patch: { content: [] } });
    assert.deepEqual(plain(inherited.outcome.message.details), { kept: true });
    assert.deepEqual(plain(inherited.outcome.message.usage), { output: 3 });
    assert.deepEqual(plain(inherited.outcome.message.content), []);
    const terminated = await p.run({ patch: { terminate: true } });
    assert.equal(terminated.outcome.terminate, true);
    const continued = await p.run({ effect: async () => ({ content: [], terminate: true }), patch: { terminate: false } });
    assert.equal(continued.outcome.terminate, false);
  });
  await check('closed gate remains terminal across abort lifecycle transitions', async () => {
    const terminal = new Error('terminal');
    const a = p.gate.createGate();
    a.control.beginAbort(Promise.resolve()); a.control.close(terminal);
    assert.throws(() => a.gate.admit(() => {}), (error) => error === terminal);
    const b = p.gate.createGate();
    b.control.close(terminal); b.control.beginAbort(Promise.resolve()); b.control.signalAbort();
    assert.throws(() => b.gate.admit(() => {}), (error) => error === terminal);
    assert.equal(b.gate.signal.reason, terminal);
  });
  await check('completion fences late callbacks and publication waits for actual effect', async () => {
    let release;
    let entered;
    const enteredPromise = new Promise((resolve) => { entered = resolve; });
    const barrier = new Promise((resolve) => { release = resolve; });
    let finished = false;
    const pending = p.run({ effect: async () => { entered(); await barrier; return { content: [] }; } })
      .then((value) => { finished = true; return value; });
    await enteredPromise;
    assert.equal(finished, false);
    release();
    const result = await pending;
    const before = result.events.length;
    result.callback({ content: [{ type: 'text', text: 'too late' }] }, { checkpoint: true });
    assert.equal(result.events.length, before, 'completed invocation must ignore late updates');
    assert.equal(result.updates.length, 0);
    assert.equal(result.checkpoints.length, 0);
  });
  await check('publication waits for an independently blocked durable progress drain', async () => {
    let drainEntered;
    let releaseDrain;
    let published = false;
    const entered = new Promise((resolve) => { drainEntered = resolve; });
    const barrier = new Promise((resolve) => { releaseDrain = resolve; });
    const pending = p.run({
      progressDrain: async () => { drainEntered(); await barrier; },
      onPublish: () => { published = true; },
    });
    await entered;
    assert.equal(published, false);
    releaseDrain();
    const result = await pending;
    assert.equal(published, true);
    ordered(result.events, ['drain', 'drain-complete', 'publish']);
  });
  await check('aborting and closed gates block the actual recovered effect chain', async () => {
    const aborted = await p.run({ gateState: 'aborting' });
    assert.equal(aborted.events.includes('invoke'), false);
    assert.equal(aborted.outcome.message.isError, true);
    assert.equal(aborted.events.filter((event) => event === 'publish').length, 1);
    const terminal = new Error('closed recovery');
    let invoked = false, published = false;
    await assert.rejects(p.run({ gateState: 'closed', gateError: terminal,
      effect: async () => { invoked = true; return { content: [] }; },
      onPublish: () => { published = true; },
    }), (error) => error === terminal);
    assert.equal(invoked, false);
    assert.equal(published, false);
  });
  await check('tool failure also fences late callbacks', async () => {
    const result = await p.run({ effect: async () => { throw new Error('failed tool'); } });
    assert.equal(result.outcome.message.isError, true);
    const before = result.events.length;
    result.callback({ content: [] }, { checkpoint: true });
    assert.equal(result.events.length, before);
  });
}

try {
  const suite = { 'resource-consistency': resource, 'session-integrity': session, 'execution-lifecycle': execution }[episode];
  assert.ok(suite, `unknown advanced episode ${episode}`);
  await suite();
  console.log(JSON.stringify({ status: 'passed', checks }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
