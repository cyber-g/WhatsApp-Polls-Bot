'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { setTimeout: sleep } = require('node:timers/promises');
const exec = require('node:util').promisify(require('node:child_process').execFile);
const { makeClient, packSession, storage, bounded, connect, metadataToken } = require('../../lib/runtime.cjs');
const { sendPoll } = require('../01-poll/poll-example.cjs');

const PREFIX = 'exercises/fixed-20261014';
const SLOTS = ['12:30', '12:32', '12:34', '12:36'];

function log(event, details = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...details }));
}

function slotWindow(slot) {
  if (!SLOTS.includes(slot)) throw new Error('FIXED_POLL_SLOT attendu : 12:30, 12:32, 12:34 ou 12:36.');
  const start = Date.parse(`2026-10-14T${slot}:00+02:00`);
  return { prepare: start - 180000, start, end: start + 120000 };
}

function inWindow(slot, now = Date.now()) {
  const { start, end } = slotWindow(slot);
  return now >= start && now < end;
}

async function publishSlot(store, slot, groupId, publish, now = Date.now) {
  if (!inWindow(slot, now())) {
    log('slot_skipped', { slot, reason: 'outside_window' });
    return 'outside_window';
  }
  const key = `${PREFIX}/polls/${groupId}/${slot.replace(':', '')}.json`;
  let reservation;
  try {
    reservation = await store.put(key, JSON.stringify({ status: 'pending', slot }), 0);
  } catch (error) {
    if (error.status !== 412) throw error;
    log('slot_skipped', { slot, reason: 'already_recorded' });
    return 'already_recorded';
  }
  if (!inWindow(slot, now())) {
    await store.put(key, JSON.stringify({ status: 'expired', slot }), reservation.generation);
    log('slot_skipped', { slot, reason: 'outside_window' });
    return 'outside_window';
  }
  await publish();
  // Un retour sans ID n'est pas une preuve d'echec ni une confirmation de livraison.
  await store.put(key, JSON.stringify({
    status: 'call_completed', slot, time: new Date(now()).toISOString(),
  }), reservation.generation);
  return 'call_completed';
}

async function waitForSlot(slot, now = Date.now, wait = sleep) {
  const { start } = slotWindow(slot);
  if (now() < start) log('waiting_for_slot', { slot });
  while (now() < start) await wait(Math.min(1000, start - now()));
}

async function acquireSession(store, slot, execution, now = Date.now, wait = sleep) {
  const { end } = slotWindow(slot);
  let waiting = false;
  while (now() < end) {
    try {
      const lock = await store.put(`${PREFIX}/lock.json`, JSON.stringify({ slot, execution }), 0);
      log('session_locked', { slot });
      return lock;
    } catch (error) {
      if (error.status !== 412) throw error;
      if (!waiting) {
        log('waiting_for_session', { slot });
        waiting = true;
      }
      await wait(Math.min(1000, Math.max(0, end - now())));
    }
  }
  throw new Error('Creneau expire en attendant le verrou ; aucun envoi. Verifier les executions precedentes.');
}

async function run(env = process.env, {
  createClient = makeClient, Poll: PollType, now = Date.now, wait = sleep,
} = {}) {
  const slot = env.FIXED_POLL_SLOT;
  const window = slotWindow(slot);
  if (!env.CLOUD_RUN_JOB || !env.STATE_BUCKET || !/^[\d-]+@g\.us$/.test(env.GROUP_ID || '')) {
    throw new Error('Cloud Run Job, STATE_BUCKET et GROUP_ID de groupe requis.');
  }
  log('execution_started', { slot, scheduledAt: new Date(window.start).toISOString() });
  if (now() < window.prepare || now() >= window.end) {
    return log('slot_skipped', { slot, reason: 'outside_preparation_window' });
  }

  const token = await metadataToken();
  const store = storage(env.STATE_BUCKET, token);
  const key = `${PREFIX}/polls/${env.GROUP_ID}/${slot.replace(':', '')}.json`;
  if (await store.get(key)) return log('slot_skipped', { slot, reason: 'already_recorded' });

  const lockKey = `${PREFIX}/lock.json`;
  const lock = await acquireSession(store, slot, env.CLOUD_RUN_EXECUTION, now, wait);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-fixed-poll-'));
  const profile = path.join(tmp, 'profile');
  const archive = path.join(tmp, 'session.tar.gz');
  let client;
  let normal = false;
  let connected = false;
  let connectionError;
  const onDisconnected = () => {
    connected = false;
    connectionError = new Error('Client deconnecte : verifier WhatsApp, aucun retry.');
    log('error', { stage: 'connection', message: connectionError.message });
  };
  try {
    const saved = await store.get(`${PREFIX}/session.tar.gz`);
    if (!saved) throw new Error('Archive de session de cet exercice absente.');
    await fs.writeFile(archive, saved, { mode: 0o600 });
    await fs.mkdir(profile, { mode: 0o700 });
    await exec('tar', ['--no-same-owner', '-xzf', archive, '-C', profile]);
    client = createClient(profile);
    client.on('disconnected', onDisconnected);
    await connect(client, Math.max(1, Math.min(75000, window.end - now())));
    if (connectionError) throw connectionError;
    connected = true;
    await waitForSlot(slot, now, wait);
    if (connectionError) throw connectionError;
    const Poll = PollType || require('whatsapp-web.js').Poll;
    await publishSlot(store, slot, env.GROUP_ID, async () => {
      if (!connected) throw connectionError;
      await bounded(sendPoll(client, Poll, env.GROUP_ID, {
        scheduledAt: new Date(slotWindow(slot).start).toISOString(),
      }), 20000);
      if (connectionError) throw connectionError;
    }, now);
    normal = true;
  } finally {
    try {
      if (client) client.off('disconnected', onDisconnected);
      if (client?.pupBrowser) await bounded(client.destroy(), 10000);
      if (normal) {
        await packSession(profile, archive);
        await store.put(`${PREFIX}/session.tar.gz`, await fs.readFile(archive));
        log('session_saved', { slot });
        await store.remove(lockKey, lock.generation);
        log('done', { slot });
      } else {
        log('exercise_blocked', { slot, message: 'Verrou conserve ; verifier WhatsApp. Aucun retry.' });
      }
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  }
}

module.exports = { slotWindow, inWindow, connect, publishSlot, waitForSlot, acquireSession, run };
if (require.main === module) {
  run().catch(error => {
    log('error', { message: error?.message || String(error) });
    process.exitCode = 1;
  });
}
