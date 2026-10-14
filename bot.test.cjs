'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const exec = require('node:util').promisify(require('node:child_process').execFile);
const { dateAfter, dailyWindow, selectEvent, validateConfig, identifyGroup, run, main } = require('./bot.cjs');
const { packSession, storage } = require('./lib/runtime.cjs');

const HEADER = ['Date', 'Actif', 'Titre'];
const ENV = {
  CLOUD_RUN_JOB: 'daily-test', SPREADSHEET_ID: 'sheet', SHEETS_READER: 'reader',
  STATE_BUCKET: 'bucket', GROUP_ID: '123@g.us', DRY_RUN: 'false',
};

test('calendar days and 09:00 Paris across midnight, DST, leap year and year end', () => {
  for (const [instant, tomorrow, start] of [
    ['2026-10-13T23:30:00Z', '2026-10-15', '2026-10-14T07:00:00Z'],
    ['2026-03-28T12:00:00Z', '2026-03-29', '2026-03-28T08:00:00Z'],
    ['2026-03-29T12:00:00Z', '2026-03-30', '2026-03-29T07:00:00Z'],
    ['2026-10-25T12:00:00Z', '2026-10-26', '2026-10-25T08:00:00Z'],
    ['2026-12-31T12:00:00Z', '2027-01-01', '2026-12-31T08:00:00Z'],
    ['2028-02-28T12:00:00Z', '2028-02-29', '2028-02-28T08:00:00Z'],
  ]) {
    const date = new Date(instant);
    assert.equal(dateAfter(1, date), tomorrow);
    const window = dailyWindow(date);
    assert.equal(window.start, Date.parse(start));
    assert.equal(window.start - window.prepare, 180000);
    assert.equal(window.end - window.start, 900000);
  }
  assert.equal(dateAfter(1, new Date('2026-10-13T23:30:00Z'), 'UTC'), '2026-10-14');
});

test('Sheets selects tomorrow, expands the title, defaults and skips inactive/absent events', () => {
  const date = '2026-10-15';
  assert.deepEqual(selectEvent([HEADER, [date, ' oui ', 'Cours du {date}']], date), {
    date, question: 'Cours du 15/10/2026',
  });
  assert.equal(selectEvent([HEADER, [date, 'OUI']], date).question,
    'TEST — Événement du 15/10/2026 : présent ?');
  assert.equal(selectEvent([HEADER, [date, 'NON']], date), null);
  assert.equal(selectEvent([HEADER], date), null);
});

test('malformed Sheets data, impossible dates and duplicate active dates are explicit errors', () => {
  for (const rows of [[], null, {}, [HEADER, null], [['Wrong', 'Actif', 'Titre']],
    [HEADER, [46311, 'OUI']], [HEADER, ['15/10/2026', 'OUI']],
    [HEADER, ['2026-02-30', 'OUI']], [HEADER, ['2026-13-01', 'OUI']],
    [HEADER, ['2026-10-15', 'OUI'], ['2026-10-15', 'OUI']]]) {
    assert.throws(() => selectEvent(rows, '2026-10-15'));
  }
});

test('configuration accepts ID-only destination, safe simulation and rejects incompatible legacy settings', () => {
  validateConfig(ENV);
  validateConfig({ ...ENV, DRY_RUN: undefined });
  for (const change of [{ SPREADSHEET_ID: '' }, { SHEETS_READER: '' }, { STATE_BUCKET: '' },
    { GROUP_ID: '123@c.us' }, { TIME_ZONE: 'UTC' }, { LEAD_DAYS: '2' }, { DRY_RUN: 'FALSE' }]) {
    assert.throws(() => validateConfig({ ...ENV, ...change }));
  }
});

test('group discovery reads incoming or own command destination without sending or serializing chats', async t => {
  t.mock.method(console, 'log', () => {});
  for (const fromMe of [false, true]) {
    const client = new EventEmitter();
    client.sendMessage = () => assert.fail('discovery must not send');
    client.getChats = () => assert.fail('no chat serialization');
    const pending = identifyGroup(client, 1000);
    client.emit('message_create', { body: 'unrelated', from: '999@g.us' });
    client.emit('message_create', { body: '!groupid', from: '123@c.us' });
    client.emit('message_create', { body: '!groupid', from: undefined });
    client.emit('message_create', {
      body: '!groupid', fromMe, from: fromMe ? 'own@c.us' : '123-456@g.us',
      to: fromMe ? '123-456@g.us' : 'own@c.us',
    });
    assert.equal(await pending, '123-456@g.us');
    assert.equal(client.listenerCount('message_create'), 0);
  }
  const client = new EventEmitter();
  await assert.rejects(identifyGroup(client, 5), /Delai depasse/);
  assert.equal(client.listenerCount('message_create'), 0);
});

async function fixture(t) {
  const logs = t.mock.method(console, 'log', () => {});
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-daily-test-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const source = path.join(tmp, 'source');
  const archive = path.join(tmp, 'input.tar.gz');
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'state'), 'initial');
  await packSession(source, archive);
  const objects = new Map([['session.tar.gz', {
    bytes: await fs.readFile(archive), generation: '1',
  }]]);
  let generation = 1;
  const f = {
    tmp, source, objects, calls: [], sends: [], closes: 0, profiles: [],
    eventDate: '2026-10-15',
    values: [HEADER, ['2026-10-15', 'OUI', 'Cours du {date}']],
    clock: Date.parse('2026-10-14T06:57:00Z'),
    events: () => logs.mock.calls.map(call => JSON.parse(call.arguments[0])),
  };
  t.mock.method(globalThis, 'fetch', async (urlString, options = {}) => {
    const url = new URL(urlString);
    f.calls.push({ url, options });
    if (url.hostname === 'metadata.google.internal') {
      assert.equal(options.headers['Metadata-Flavor'], 'Google');
      return new Response(JSON.stringify({ access_token: 'fake-token' }));
    }
    if (url.hostname === 'iamcredentials.googleapis.com') {
      assert.equal(options.headers.Authorization, 'Bearer fake-token');
      assert.deepEqual(JSON.parse(options.body).scope,
        ['https://www.googleapis.com/auth/spreadsheets.readonly']);
      return new Response(JSON.stringify({ accessToken: 'fake-sheets' }));
    }
    if (url.hostname === 'sheets.googleapis.com') {
      assert.equal(options.headers.Authorization, 'Bearer fake-sheets');
      assert.equal(url.searchParams.get('valueRenderOption'), 'UNFORMATTED_VALUE');
      return new Response(JSON.stringify({ values: f.values }));
    }
    assert.equal(url.hostname, 'storage.googleapis.com');
    const key = url.pathname.startsWith('/upload/') ? url.searchParams.get('name') :
      decodeURIComponent(url.pathname.split('/o/')[1]);
    const old = objects.get(key);
    if (options.method === 'POST' || options.method === 'DELETE') {
      if (f.failSave && key === 'session.tar.gz') return new Response('', { status: 403 });
      if (f.expireOnReservation && key.startsWith('polls/') &&
        url.searchParams.get('ifGenerationMatch') === '0') {
        f.clock = Date.parse('2026-10-14T07:15:00Z');
      }
      const expected = url.searchParams.get('ifGenerationMatch');
      if (expected !== null &&
        ((expected === '0' && old) || (expected !== '0' && expected !== old?.generation))) {
        return new Response('', { status: 412 });
      }
      if (options.method === 'DELETE') {
        objects.delete(key);
        return new Response(null, { status: 204 });
      }
      const record = { bytes: Buffer.from(options.body), generation: String(++generation) };
      objects.set(key, record);
      return new Response(JSON.stringify({ generation: record.generation }));
    }
    return old ? new Response(old.bytes) : new Response('', { status: 404 });
  });
  f.dependencies = {
    now: () => f.clock,
    wait: async milliseconds => {
      f.clock += milliseconds;
      if (f.disconnectWhileWaiting) f.client.emit('disconnected');
    },
    Poll: class {
      constructor(question, options, settings) { Object.assign(this, { question, options, settings }); }
    },
    createClient(profile) {
      f.profiles.push(profile);
      const client = new EventEmitter();
      f.client = client;
      client.pupBrowser = {};
      client.initialize = async () => {
        assert.equal(await fs.readFile(path.join(profile, 'state'), 'utf8'), f.expectedState || 'initial');
        if (f.expireOnReady) f.clock = Date.parse('2026-10-14T07:15:00Z');
        client.emit(f.expiredAuth ? 'qr' : 'ready');
      };
      client.getChatById = () => assert.fail('no group serialization');
      client.sendMessage = async (...args) => {
        const marker = objects.get(`polls/123@g.us/${f.eventDate}.json`);
        assert.equal(JSON.parse(marker.bytes).status, 'pending');
        const window = dailyWindow(new Date(f.clock));
        assert.ok(f.clock >= window.start);
        assert.ok(f.clock < window.end);
        f.sends.push(args);
        if (f.failSend) throw new Error('uncertain');
        return undefined;
      };
      client.destroy = async () => {
        f.closes++;
        await fs.writeFile(path.join(profile, 'state'), 'updated');
      };
      return client;
    },
  };
  return f;
}

test('daily run prepares early, waits until 09:00, sends tomorrow title without response ID, closes and saves', async t => {
  const f = await fixture(t);
  await run(ENV, f.dependencies);
  assert.equal(f.clock, Date.parse('2026-10-14T07:00:00Z'));
  assert.equal(f.sends.length, 1);
  const [destination, poll, options] = f.sends[0];
  assert.equal(destination, ENV.GROUP_ID);
  assert.equal(poll.question, 'Cours du 15/10/2026');
  assert.deepEqual(poll.options, ['oui', 'non']);
  assert.deepEqual(poll.settings, { allowMultipleAnswers: false });
  assert.deepEqual(options, { sendSeen: false, waitUntilMsgSent: true });
  assert.equal(f.closes, 1);
  assert.equal(f.objects.has('lock.json'), false);
  const marker = JSON.parse(f.objects.get('polls/123@g.us/2026-10-15.json').bytes);
  assert.equal(marker.status, 'call_completed');
  assert.equal(marker.responseHasId, false);
  const restored = path.join(f.tmp, 'verify');
  await fs.mkdir(restored);
  const saved = path.join(restored, 'saved.tar.gz');
  await fs.writeFile(saved, f.objects.get('session.tar.gz').bytes);
  await exec('tar', ['--no-same-owner', '-xzf', saved, '-C', restored]);
  assert.equal(await fs.readFile(path.join(restored, 'state'), 'utf8'), 'updated');
  await assert.rejects(fs.stat(f.profiles[0]), { code: 'ENOENT' });
  assert.ok(f.events().some(event => event.event === 'waiting_for_slot'));
  await run(ENV, f.dependencies);
  assert.equal(f.sends.length, 1);
  assert.equal(f.profiles.length, 1);
});

test('safe simulation works outside publication hours and never touches state or browser', async t => {
  const f = await fixture(t);
  f.clock = Date.parse('2026-10-14T12:00:00Z');
  await run({ ...ENV, DRY_RUN: undefined }, f.dependencies);
  assert.equal(f.calls.length, 3);
  assert.equal(f.profiles.length, 0);
  assert.ok(f.events().some(event => event.event === 'dry_run'));
});

test('the next daily execution restores the saved session and reserves the next event without deleting history', async t => {
  const f = await fixture(t);
  await run(ENV, f.dependencies);
  const firstMarker = f.objects.get('polls/123@g.us/2026-10-15.json');
  f.clock = Date.parse('2026-10-15T06:57:00Z');
  f.eventDate = '2026-10-16';
  f.values = [HEADER, [f.eventDate, 'OUI', 'Cours du {date}']];
  f.expectedState = 'updated';
  await run(ENV, f.dependencies);
  assert.equal(f.sends.length, 2);
  assert.equal(f.sends[1][1].question, 'Cours du 16/10/2026');
  assert.equal(f.objects.get('polls/123@g.us/2026-10-15.json'), firstMarker);
  assert.equal(JSON.parse(f.objects.get('polls/123@g.us/2026-10-16.json').bytes).status, 'call_completed');
  assert.equal(f.closes, 2);
  assert.equal(f.objects.has('lock.json'), false);
});

test('missing Google tokens, permission failures and malformed Sheets responses are not silent no-event results', async t => {
  t.mock.method(console, 'log', () => {});
  const now = () => Date.parse('2026-10-14T06:57:00Z');
  for (const responses of [
    [{}],
    [{ access_token: 'fake' }, {}],
    [new Response('', { status: 403 })],
    [{ access_token: 'fake' }, { accessToken: 'sheets' }, { values: {} }],
  ]) {
    const network = t.mock.method(globalThis, 'fetch', async () => {
      const result = responses.shift();
      assert.notEqual(result, undefined);
      return result instanceof Response ? result : new Response(JSON.stringify(result));
    });
    await assert.rejects(run(ENV, { now, createClient: () => assert.fail('no browser') }));
    network.mock.restore();
  }
});

test('no active event never opens WhatsApp or accesses state', async t => {
  const f = await fixture(t);
  f.values = [HEADER, ['2026-10-15', 'NON']];
  await run(ENV, f.dependencies);
  assert.equal(f.calls.length, 3);
  assert.equal(f.profiles.length, 0);
  assert.ok(f.events().some(event => event.event === 'no_event'));
});

test('real run outside 08:57-09:15 never accesses network; non-Cloud Run publication is rejected', async t => {
  const f = await fixture(t);
  for (const instant of ['2026-10-14T06:56:59Z', '2026-10-14T07:15:00Z']) {
    f.clock = Date.parse(instant);
    await run(ENV, f.dependencies);
  }
  assert.equal(f.calls.length, 0);
  await assert.rejects(run({ ...ENV, CLOUD_RUN_JOB: undefined }, f.dependencies), /Cloud Run Job/);
});

test('old sent and pending markers prevent another publication without changing history', async t => {
  const f = await fixture(t);
  for (const status of ['sent', 'pending', 'call_completed']) {
    const key = 'polls/123@g.us/2026-10-15.json';
    const record = { bytes: Buffer.from(JSON.stringify({ status })), generation: '99' };
    f.objects.set(key, record);
    await run(ENV, f.dependencies);
    assert.equal(f.objects.get(key), record);
  }
  assert.equal(f.profiles.length, 0);
});

test('late start is allowed before 09:15 without waiting for another day', async t => {
  const f = await fixture(t);
  f.clock = Date.parse('2026-10-14T07:14:59Z');
  await run(ENV, f.dependencies);
  assert.equal(f.sends.length, 1);
  assert.equal(f.clock, Date.parse('2026-10-14T07:14:59Z'));
});

test('deadline reached during connection or reservation skips sending and preserves the closed session', async t => {
  const f = await fixture(t);
  f.expireOnReady = true;
  await run(ENV, f.dependencies);
  assert.equal(f.sends.length, 0);
  assert.equal(f.objects.has('lock.json'), false);
  f.expireOnReady = false;
  f.expireOnReservation = true;
  f.expectedState = 'updated';
  f.clock = Date.parse('2026-10-14T07:00:00Z');
  await run(ENV, f.dependencies);
  assert.equal(f.sends.length, 0);
  assert.equal(JSON.parse(f.objects.get('polls/123@g.us/2026-10-15.json').bytes).status, 'expired');
});

test('uncertain send keeps pending marker, old session and lock without retry', async t => {
  const f = await fixture(t);
  const oldSession = f.objects.get('session.tar.gz');
  f.failSend = true;
  await assert.rejects(run(ENV, f.dependencies), /uncertain/);
  assert.equal(f.sends.length, 1);
  assert.equal(f.closes, 1);
  assert.equal(f.objects.get('session.tar.gz'), oldSession);
  assert.equal(f.objects.has('lock.json'), true);
  assert.equal(JSON.parse(f.objects.get('polls/123@g.us/2026-10-15.json').bytes).status, 'pending');
  await run(ENV, f.dependencies);
  assert.equal(f.sends.length, 1);
});

test('expired auth, disconnection while waiting, missing archive and save failure all retain the lock', async t => {
  for (const failure of ['expiredAuth', 'disconnectWhileWaiting', 'missingArchive', 'failSave']) {
    await t.test(failure, async t => {
      const f = await fixture(t);
      if (failure === 'missingArchive') f.objects.delete('session.tar.gz');
      else f[failure] = true;
      await assert.rejects(run(ENV, f.dependencies));
      assert.equal(f.objects.has('lock.json'), true);
      assert.equal(f.events().some(event => event.event === 'done'), false);
      assert.equal(f.sends.length, failure === 'failSave' ? 1 : 0);
      for (const profile of f.profiles) await assert.rejects(fs.stat(profile), { code: 'ENOENT' });
    });
  }
});

test('private archive excludes singleton locks and caches; REST preserves atomic preconditions and real errors', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.source, 'session', 'Default', 'Cache'), { recursive: true });
  await fs.writeFile(path.join(f.source, 'session', 'Default', 'Cache', 'cache'), 'discard');
  await fs.writeFile(path.join(f.source, 'session', 'Default', 'IndexedDB'), 'keep');
  await fs.symlink('old-host', path.join(f.source, 'session', 'SingletonLock'));
  const archive = path.join(f.tmp, 'private.tar.gz');
  await packSession(f.source, archive);
  const { stdout } = await exec('tar', ['-tzf', archive]);
  assert.match(stdout, /IndexedDB/);
  assert.doesNotMatch(stdout, /Singleton|Cache/);
  assert.equal((await fs.stat(archive)).mode & 0o777, 0o600);
  const calls = [];
  const network = t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: new URL(url), options });
    return new Response(JSON.stringify({ generation: '321' }));
  });
  const store = storage('bucket', 'fake');
  await store.put('polls/123@g.us/2026-10-15.json', '{}', 0);
  await store.remove('lock.json', '321');
  assert.equal(calls[0].url.searchParams.get('ifGenerationMatch'), '0');
  assert.equal(calls[1].url.searchParams.get('ifGenerationMatch'), '321');
  network.mock.mockImplementation(async () => new Response('', { status: 404 }));
  assert.equal(await store.get('missing'), null);
  network.mock.mockImplementation(async () => new Response('', { status: 403 }));
  await assert.rejects(store.get('forbidden'), /HTTP 403/);
});

test('calendar still emits 365 events and removed commands fail explicitly', async t => {
  const output = t.mock.method(console, 'log', () => {});
  await main('calendar');
  assert.equal(output.mock.callCount(), 366);
  assert.equal(output.mock.calls[0].arguments[0], 'Date,Actif,Titre');
  await assert.rejects(main('groups'), /retiré/);
  await assert.rejects(main('pair', { CLOUD_RUN_JOB: 'test' }), /interactif/);
  await assert.rejects(main('group-id', { CLOUD_RUN_JOB: 'test' }), /interactif/);
});
