'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const exec = require('node:util').promisify(require('node:child_process').execFile);
const { packSession } = require('../../lib/runtime.cjs');
const { slotWindow, inWindow, connect, publishSlot, waitForSlot, acquireSession, run } = require('./cloud-poll-exercise.cjs');
const { sendPoll } = require('../01-poll/poll-example.cjs');

test('four fixed Paris slots, exclusive two-minute windows and no other date', () => {
  for (const [slot, utc] of [['12:30', '10:30'], ['12:32', '10:32'], ['12:34', '10:34'], ['12:36', '10:36']]) {
    const { prepare, start, end } = slotWindow(slot);
    assert.equal(start, Date.parse(`2026-10-14T${utc}:00Z`));
    assert.equal(end - start, 120000);
    assert.equal(start - prepare, 180000);
    assert.equal(inWindow(slot, start - 1), false);
    assert.equal(inWindow(slot, start), true);
    assert.equal(inWindow(slot, end - 1), true);
    assert.equal(inWindow(slot, end), false);
    assert.equal(inWindow(slot, start + 86400000), false);
  }
  for (const slot of [undefined, '12:38', '11:50', '11:10', '../session']) {
    assert.throws(() => slotWindow(slot), /FIXED_POLL_SLOT/);
  }
});

test('connection waits for ready, rejects QR/failure/disconnection/timeout and removes listeners', async t => {
  t.mock.method(console, 'log', () => {});
  for (const event of ['ready', 'qr', 'auth_failure', 'disconnected', 'timeout', 'initialize_error']) {
    const client = new EventEmitter();
    client.initialize = async () => {
      client.emit('authenticated');
      if (event === 'initialize_error') throw new Error('initialize failed');
      if (event !== 'timeout') client.emit(event);
    };
    if (event === 'ready') await connect(client, 10);
    else await assert.rejects(connect(client, 10));
    assert.deepEqual(client.eventNames(), []);
  }
});

function fakeStore() {
  const objects = new Map();
  let generation = 0;
  return {
    objects,
    async put(key, body, expected) {
      const old = objects.get(key);
      if ((expected === 0 && old) || (expected !== 0 && expected !== old?.generation)) {
        throw Object.assign(new Error('precondition'), { status: 412 });
      }
      const record = { body: JSON.parse(body), generation: String(++generation) };
      objects.set(key, record);
      return record;
    },
  };
}

test('early readiness waits for the target; late readiness waits no further', async t => {
  t.mock.method(console, 'log', () => {});
  const { prepare, start } = slotWindow('12:30');
  let clock = prepare;
  let waits = 0;
  await waitForSlot('12:30', () => clock, async milliseconds => {
    assert.ok(milliseconds > 0 && milliseconds <= 1000);
    clock += milliseconds;
    waits++;
  });
  assert.equal(clock, start);
  assert.equal(waits, 180);
  clock = start + 20000;
  await waitForSlot('12:30', () => clock, () => assert.fail('late client must not wait'));
});

test('session contention waits for release without stealing; retained lock expires and other errors propagate', async t => {
  t.mock.method(console, 'log', () => {});
  const store = fakeStore();
  const key = 'exercises/fixed-20261014/lock.json';
  await store.put(key, JSON.stringify({ slot: '12:30' }), 0);
  let clock = slotWindow('12:32').prepare;
  let waits = 0;
  const lock = await acquireSession(store, '12:32', 'execution', () => clock, async milliseconds => {
    assert.equal(store.objects.get(key).body.slot, '12:30');
    clock += milliseconds;
    waits++;
    if (waits === 3) store.objects.delete(key);
  });
  assert.equal(waits, 3);
  assert.equal(store.objects.get(key).body.slot, '12:32');
  assert.equal(lock.generation, store.objects.get(key).generation);
  clock = slotWindow('12:34').end - 1000;
  await assert.rejects(acquireSession(store, '12:34', 'later', () => clock,
    async milliseconds => { clock += milliseconds; }), /expire.*verrou/);
  assert.equal(store.objects.get(key).body.slot, '12:32');
  await assert.rejects(acquireSession({
    put: async () => { throw Object.assign(new Error('forbidden'), { status: 403 }); },
  }, '12:34', 'later', () => slotWindow('12:34').prepare), /forbidden/);
});

test('four slots use the proven identical poll payload and no response ID is required', async t => {
  t.mock.method(console, 'log', () => {});
  const store = fakeStore();
  const sent = [];
  const client = { sendMessage: async (...args) => { sent.push(args); } };
  class Poll {
    constructor(question, options, settings) { Object.assign(this, { question, options, settings }); }
  }
  for (const slot of ['12:30', '12:32', '12:34', '12:36']) {
    const publish = () => sendPoll(client, Poll, '123@g.us');
    const now = () => slotWindow(slot).start;
    assert.equal(await publishSlot(store, slot, '123@g.us', publish, now), 'call_completed');
    assert.equal(await publishSlot(store, slot, '123@g.us', publish, now), 'already_recorded');
  }
  assert.equal(sent.length, 4);
  for (const [destination, poll, options] of sent) {
    assert.equal(destination, '123@g.us');
    assert.equal(poll.question, 'TEST : present ?');
    assert.deepEqual(poll.options, ['oui', 'non']);
    assert.deepEqual(poll.settings, { allowMultipleAnswers: false });
    assert.deepEqual(options, { sendSeen: false, waitUntilMsgSent: true });
  }
  assert.equal(store.objects.size, 4);
  assert.ok([...store.objects.values()].every(record => record.body.status === 'call_completed'));
});

test('concurrent invocations and uncertain sends are reserved durably without retry', async t => {
  t.mock.method(console, 'log', () => {});
  const store = fakeStore();
  let attempts = 0;
  const publish = async () => { attempts++; throw new Error('uncertain'); };
  const now = () => slotWindow('12:30').start;
  const results = await Promise.allSettled([
    publishSlot(store, '12:30', '123@g.us', publish, now),
    publishSlot(store, '12:30', '123@g.us', publish, now),
  ]);
  assert.equal(attempts, 1);
  assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  assert.equal([...store.objects.values()][0].body.status, 'pending');
  assert.equal(await publishSlot(store, '12:30', '123@g.us', publish, now), 'already_recorded');
});

test('expired slots never send, including expiration during reservation', async t => {
  t.mock.method(console, 'log', () => {});
  const store = fakeStore();
  const { start, end } = slotWindow('12:36');
  const never = () => assert.fail('no send expected');
  assert.equal(await publishSlot(store, '12:36', '123@g.us', never, () => end), 'outside_window');
  assert.equal(store.objects.size, 0);
  let calls = 0;
  assert.equal(await publishSlot(store, '12:36', '123@g.us', never,
    () => calls++ === 0 ? start : end), 'outside_window');
  assert.equal([...store.objects.values()][0].body.status, 'expired');
});

test('storage failures propagate and invalid or expired jobs do not access the network', async t => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', () => assert.fail('no network expected'));
  const store = { put: async () => { throw Object.assign(new Error('forbidden'), { status: 403 }); } };
  await assert.rejects(publishSlot(store, '12:30', '123@g.us', () => assert.fail(),
    () => slotWindow('12:30').start), /forbidden/);
  await assert.rejects(run({}), /FIXED_POLL_SLOT/);
  await assert.rejects(run({ FIXED_POLL_SLOT: '12:30' }), /Cloud Run Job/);
  t.mock.method(Date, 'now', () => Date.parse('2026-10-15T09:10:00Z'));
  await run({ CLOUD_RUN_JOB: 'test', STATE_BUCKET: 'test', GROUP_ID: '123@g.us', FIXED_POLL_SLOT: '12:30' });
});

test('independent executions restore the updated session, close before export and retain locks on failures', async t => {
  t.mock.method(console, 'log', () => {});
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-fixed-test-'));
  try {
    const source = path.join(tmp, 'source');
    const archive = path.join(tmp, 'input.tar.gz');
    await fs.mkdir(source);
    await fs.writeFile(path.join(source, 'state'), 'initial');
    await packSession(source, archive);
    const prefix = 'exercises/fixed-20261014';
    const objects = new Map([[`${prefix}/session.tar.gz`, {
      bytes: await fs.readFile(archive), generation: '1',
    }]]);
    let generation = 1;
    t.mock.method(globalThis, 'fetch', async (urlString, options = {}) => {
      const url = new URL(urlString);
      if (url.hostname === 'metadata.google.internal') {
        return new Response(JSON.stringify({ access_token: 'fake-token' }));
      }
      assert.equal(options.headers.Authorization, 'Bearer fake-token');
      const upload = url.pathname.startsWith('/upload/');
      const key = upload ? url.searchParams.get('name') :
        decodeURIComponent(url.pathname.split('/o/')[1]);
      assert.ok(key.startsWith(`${prefix}/`), 'only isolated exercise objects may be accessed');
      const old = objects.get(key);
      if (options.method === 'POST' || options.method === 'DELETE') {
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
    let slot = '12:30';
    let clock = slotWindow(slot).prepare;
    t.mock.method(Date, 'now', () => clock);
    let expectedState = 'initial';
    let profilePath;
    let sends = 0;
    let closes = 0;
    let fail = false;
    const createClient = profile => {
      profilePath = profile;
      const client = new EventEmitter();
      client.pupBrowser = {};
      client.initialize = async () => {
        assert.equal(await fs.readFile(path.join(profile, 'state'), 'utf8'), expectedState);
        client.emit('ready');
      };
      client.sendMessage = async () => {
        sends++;
        assert.ok(clock >= slotWindow(slot).start, 'no early publication');
        const key = `${prefix}/polls/123@g.us/${slot.replace(':', '')}.json`;
        assert.equal(JSON.parse(objects.get(key).bytes).status, 'pending', 'reserve before sending');
        if (fail) throw new Error('uncertain');
      };
      client.destroy = async () => {
        closes++;
        await fs.writeFile(path.join(profile, 'state'), slot);
      };
      return client;
    };
    const env = () => ({
      CLOUD_RUN_JOB: 'test', CLOUD_RUN_EXECUTION: `test-${slot}`,
      STATE_BUCKET: 'bucket', GROUP_ID: '123@g.us', FIXED_POLL_SLOT: slot,
    });
    const dependencies = {
      createClient, Poll: class {}, now: () => clock,
      wait: async milliseconds => { clock += milliseconds; },
    };
    for (const time of ['12:30', '12:32']) {
      slot = time;
      clock = slotWindow(slot).prepare;
      await run(env(), dependencies);
      assert.equal(objects.has(`${prefix}/lock.json`), false);
      await assert.rejects(fs.stat(profilePath), { code: 'ENOENT' });
      const restored = path.join(tmp, slot.replace(':', ''));
      await fs.mkdir(restored);
      const savedArchive = path.join(tmp, 'saved.tar.gz');
      await fs.writeFile(savedArchive, objects.get(`${prefix}/session.tar.gz`).bytes);
      await exec('tar', ['--no-same-owner', '-xzf', savedArchive, '-C', restored]);
      assert.equal(await fs.readFile(path.join(restored, 'state'), 'utf8'), slot);
      expectedState = slot;
      await run(env(), { createClient: () => assert.fail('duplicate must not restore') });
    }
    assert.equal(sends, 2);
    assert.equal(closes, 2);
    const savedSession = Buffer.from(objects.get(`${prefix}/session.tar.gz`).bytes);
    slot = '12:34';
    clock = slotWindow(slot).prepare;
    fail = true;
    await assert.rejects(run(env(), dependencies), /uncertain/);
    assert.equal(closes, 3);
    assert.equal(objects.has(`${prefix}/lock.json`), true);
    assert.deepEqual(objects.get(`${prefix}/session.tar.gz`).bytes, savedSession);
    assert.equal(JSON.parse(objects.get(`${prefix}/polls/123@g.us/1234.json`).bytes).status, 'pending');
    await assert.rejects(fs.stat(profilePath), { code: 'ENOENT' });
    slot = '12:36';
    clock = slotWindow(slot).prepare;
    await assert.rejects(run(env(), {
      ...dependencies, createClient: () => assert.fail('locked must not restore'),
    }), /verrou/);
    assert.equal(sends, 3);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
