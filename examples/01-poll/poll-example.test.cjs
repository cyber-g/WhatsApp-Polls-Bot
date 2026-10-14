'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setImmediate: nextTurn } = require('node:timers/promises');
const { attachPollHandler, messageKey, scheduledPublisher } = require('./poll-example.cjs');

test('message keys accept serialized and native IDs but reject missing or malformed IDs', () => {
  assert.equal(messageKey({ id: { _serialized: 'serialized', id: 'native' } }, '123@g.us'), 'serialized');
  assert.equal(messageKey({ id: { id: 'native' } }, '123@g.us'), '123@g.us:native');
  for (const message of [null, {}, { id: {} }, { id: { id: '' } }, { id: { id: 42 } }]) {
    assert.equal(messageKey(message, '123@g.us'), null);
  }
});

test('schedule publishes the same poll at exactly four Paris slots on October 14', async t => {
  const { client, sent } = setup(t);
  class Poll {
    constructor(question, options, settings) { Object.assign(this, { question, options, settings }); }
  }
  let now = Date.parse('2026-10-14T10:09:59+02:00');
  const tick = scheduledPublisher(client, Poll, '123@g.us', () => now);
  await tick();
  assert.equal(sent.length, 0);
  for (const [index, time] of ['10:10', '10:13', '10:16', '10:19'].entries()) {
    now = Date.parse(`2026-10-14T${time}:00+02:00`);
    await tick();
    await tick();
    assert.equal(sent.length, index + 1);
    assert.equal(sent[index][0], '123@g.us');
    assert.equal(sent[index][1].question, 'TEST : present ?');
    assert.deepEqual(sent[index][1].options, ['oui', 'non']);
    assert.deepEqual(sent[index][1].settings, { allowMultipleAnswers: false });
  }
  now = Date.parse('2026-10-14T10:20:00+02:00');
  assert.equal(await tick(), true);
  assert.equal(sent.length, 4);
});

test('schedule catches up sequentially but never starts sends at or after the end of the window', async t => {
  const { client, sent } = setup(t);
  let now = Date.parse('2026-10-14T10:17:00+02:00');
  const tick = scheduledPublisher(client, class {}, '123@g.us', () => now);
  await tick();
  assert.equal(sent.length, 3);
  now = Date.parse('2026-10-14T10:20:00+02:00');
  assert.equal(await tick(), true);
  assert.equal(sent.length, 3);
  const expired = scheduledPublisher(client, class {}, '123@g.us',
    () => Date.parse('2026-10-15T10:10:00+02:00'));
  assert.equal(await expired(), true);
  assert.equal(sent.length, 3);
});

test('schedule serializes concurrent ticks and stops on an uncertain send without retry', async t => {
  const { client, logs } = setup(t);
  let attempts = 0;
  let rejectSend;
  client.sendMessage = () => {
    attempts++;
    return new Promise((resolve, reject) => { rejectSend = reject; });
  };
  const tick = scheduledPublisher(client, class {}, '123@g.us',
    () => Date.parse('2026-10-14T10:19:00+02:00'));
  const pending = tick();
  await tick();
  assert.equal(attempts, 1);
  rejectSend(new Error('uncertain'));
  assert.equal(await pending, true);
  await tick();
  assert.equal(attempts, 1);
  assert.equal(JSON.parse(logs.mock.calls.at(-1).arguments[0]).stage, 'send_poll');
});

test('catch-up checks the deadline between sends', async t => {
  const { client, sent } = setup(t);
  let now = Date.parse('2026-10-14T10:19:59+02:00');
  client.sendMessage = async (...args) => {
    sent.push(args);
    now = Date.parse('2026-10-14T10:20:01+02:00');
  };
  const tick = scheduledPublisher(client, class {}, '123@g.us', () => now);
  assert.equal(await tick(), true);
  assert.equal(sent.length, 1);
});

test('native command and returned poll IDs work without _serialized and duplicate events cannot resend', async t => {
  const { client, sent, message, logs } = setup(t);
  client.sendMessage = async (...args) => {
    sent.push(args);
    return { id: { id: 'native-poll' } };
  };
  client.emit('ready');
  const command = { ...message, id: { id: 'native-command' } };
  client.emit('message_create', command);
  await nextTurn();
  client.emit('message_create', command);
  await nextTurn();
  assert.equal(sent.length, 1);
  const result = JSON.parse(logs.mock.calls.at(-1).arguments[0]);
  assert.equal(result.event, 'poll_send_completed');
  assert.equal(result.responseHasId, true);
});

function setup(t) {
  const logs = t.mock.method(console, 'log', () => {});
  const client = new EventEmitter();
  const sent = [];
  class Poll {
    constructor(question, options, settings) {
      Object.assign(this, { question, options, settings });
    }
  }
  client.sendMessage = async (...args) => {
    sent.push(args);
    return { id: { _serialized: 'poll' } };
  };
  attachPollHandler(client, Poll, '123@g.us');
  const message = {
    body: '!sendpoll', from: '123@g.us', fromMe: false, id: { _serialized: 'command' },
    getChat: async () => assert.fail('do not serialize the chat'),
  };
  return { client, sent, message, logs };
}

test('incoming or own command publishes exactly one single-choice poll in the configured group', async t => {
  const { client, sent, message } = setup(t);
  client.emit('ready');
  client.emit('message_create', message);
  await nextTurn();
  client.emit('message_create', message);
  await nextTurn();
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0], '123@g.us');
  assert.deepEqual(sent[0][1].options, ['oui', 'non']);
  assert.equal(sent[0][1].settings.allowMultipleAnswers, false);
  assert.deepEqual(sent[0][2], { sendSeen: false, waitUntilMsgSent: true });
  client.emit('message_create', {
    ...message, fromMe: true, from: 'own@c.us', to: '123@g.us',
    id: { _serialized: 'own-command' },
  });
  await nextTurn();
  assert.equal(sent.length, 2);
});

test('wrong destination, unrelated messages and not-ready commands cannot send', async t => {
  const { client, sent, message } = setup(t);
  client.emit('message_create', message);
  client.emit('ready');
  client.emit('message_create', { ...message, from: '999@g.us' });
  client.emit('message_create', { ...message, from: '123@c.us' });
  client.emit('message_create', { ...message, fromMe: true, from: '123@g.us', to: '999@g.us' });
  client.emit('message_create', { ...message, body: 'hello' });
  client.emit('disconnected');
  client.emit('message_create', message);
  await nextTurn();
  assert.equal(sent.length, 0);
});

test('invalid configured group IDs are rejected before listeners are attached', () => {
  for (const id of [undefined, '', '123@c.us', 'status@broadcast', 'invalid@g.us']) {
    const client = new EventEmitter();
    assert.throws(() => attachPollHandler(client, class {}, id), /GROUP_ID/);
    assert.equal(client.listenerCount('message_create'), 0);
  }
});

test('missing command ID cannot send', async t => {
  const { client, sent, message, logs } = setup(t);
  client.emit('ready');
  client.emit('message_create', { ...message, id: null });
  await nextTurn();
  assert.equal(sent.length, 0);
  assert.equal(logs.mock.calls.filter(call => JSON.parse(call.arguments[0]).event === 'error').length, 1);
});

test('uncertain send is reported and the same command is not retried', async t => {
  const { client, message, logs } = setup(t);
  let attempts = 0;
  client.sendMessage = async () => { attempts++; throw new Error('network'); };
  client.emit('ready');
  client.emit('message_create', message);
  await nextTurn();
  client.emit('message_create', message);
  await nextTurn();
  assert.equal(attempts, 1);
  assert.equal(JSON.parse(logs.mock.calls.at(-1).arguments[0]).event, 'error');
  assert.equal(JSON.parse(logs.mock.calls.at(-1).arguments[0]).stage, 'send_poll');
});

test('commands arriving during a send are rejected and a resolved call without ID is not a send error', async t => {
  const { client, message, logs } = setup(t);
  let finish;
  client.sendMessage = () => new Promise(resolve => { finish = resolve; });
  client.emit('ready');
  client.emit('message_create', message);
  await nextTurn();
  client.emit('message_create', { ...message, id: { _serialized: 'second' } });
  assert.equal(JSON.parse(logs.mock.calls.at(-1).arguments[0]).reason, 'sending_in_progress');
  finish(undefined);
  await nextTurn();
  const result = JSON.parse(logs.mock.calls.at(-1).arguments[0]);
  assert.equal(result.event, 'poll_send_completed');
  assert.equal(result.responseHasId, false);
  client.emit('message_create', message);
  await nextTurn();
  assert.equal(JSON.parse(logs.mock.calls.at(-1).arguments[0]).event, 'poll_send_completed');
});
