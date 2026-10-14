'use strict';

const { log, bounded, storage, metadataToken, connect, waitUntil,
  acquireLock, publishOnce, runSession } = require('../../lib/runtime.cjs');
const { sendPoll } = require('../../lib/poll.cjs');

const PREFIX = 'exercises/fixed-20261014';
const SLOTS = ['12:30', '12:32', '12:34', '12:36'];

function slotWindow(slot) {
  if (!SLOTS.includes(slot)) throw new Error('FIXED_POLL_SLOT attendu : 12:30, 12:32, 12:34 ou 12:36.');
  const start = Date.parse(`2026-10-14T${slot}:00+02:00`);
  return { prepare: start - 180000, start, end: start + 120000 };
}

function inWindow(slot, now = Date.now()) {
  const { start, end } = slotWindow(slot);
  return now >= start && now < end;
}

async function waitForSlot(slot, now, wait) {
  if ((now || Date.now)() < slotWindow(slot).start) log('waiting_for_slot', { slot });
  await waitUntil(slotWindow(slot).start, now, wait);
}

async function acquireSession(store, slot, execution, now, wait) {
  return acquireLock(store, `${PREFIX}/lock.json`, { slot, execution }, slotWindow(slot).end, now, wait);
}

async function publishSlot(store, slot, groupId, publish, now) {
  const key = `${PREFIX}/polls/${groupId}/${slot.replace(':', '')}.json`;
  const status = await publishOnce(store, key, { slot }, publish, slotWindow(slot), now);
  if (status !== 'call_completed') log('slot_skipped', { slot, reason: status });
  return status;
}

async function run(env = process.env, dependencies = {}) {
  const slot = env.FIXED_POLL_SLOT;
  const window = slotWindow(slot);
  const now = dependencies.now || Date.now;
  if (!env.CLOUD_RUN_JOB || !env.STATE_BUCKET || !/^[\d-]+@g\.us$/.test(env.GROUP_ID || '')) {
    throw new Error('Cloud Run Job, STATE_BUCKET et GROUP_ID de groupe requis.');
  }
  log('execution_started', { slot, scheduledAt: new Date(window.start).toISOString() });
  if (now() < window.prepare || now() >= window.end) {
    return log('slot_skipped', { slot, reason: 'outside_preparation_window' });
  }
  const store = storage(env.STATE_BUCKET, await metadataToken());
  const key = `${PREFIX}/polls/${env.GROUP_ID}/${slot.replace(':', '')}.json`;
  if (await store.get(key)) return log('slot_skipped', { slot, reason: 'already_recorded' });
  await runSession({
    store, sessionKey: `${PREFIX}/session.tar.gz`, lockKey: `${PREFIX}/lock.json`,
    window, details: { slot, execution: env.CLOUD_RUN_EXECUTION },
  }, async (client, guard) => {
    const Poll = dependencies.Poll || require('whatsapp-web.js').Poll;
    await publishSlot(store, slot, env.GROUP_ID, async () => {
      guard();
      const result = await bounded(sendPoll(client, Poll, env.GROUP_ID, {
        slot, scheduledAt: new Date(window.start).toISOString(),
      }), 20000);
      guard();
      return result;
    }, now);
  }, dependencies);
}

module.exports = { slotWindow, inWindow, connect, publishSlot, waitForSlot, acquireSession, run };
if (require.main === module) {
  run().catch(error => {
    log('error', { message: error?.message || String(error) });
    process.exitCode = 1;
  });
}
