'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { setTimeout: sleep } = require('node:timers/promises');
const exec = require('node:util').promisify(require('node:child_process').execFile);

function log(event, details = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(),
    severity: event === 'error' ? 'ERROR' : 'INFO', event, ...details }));
}

async function bounded(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Delai depasse ; aucun retry automatique.')), milliseconds);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(60000) });
  if (!response.ok) {
    throw Object.assign(new Error(`HTTP ${response.status} - ${new URL(url).hostname}`), {
      status: response.status,
    });
  }
  return response;
}

async function metadataToken() {
  const response = await request(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' } });
  const { access_token: token } = await response.json();
  if (typeof token !== 'string' || !token) throw new Error('Jeton metadata absent.');
  return token;
}

function storage(bucket, token) {
  const root = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/`;
  const headers = { Authorization: `Bearer ${token}` };
  return {
    async get(name) {
      try {
        const response = await request(`${root}${encodeURIComponent(name)}?alt=media`, { headers });
        return Buffer.from(await response.arrayBuffer());
      } catch (error) {
        if (error.status === 404) return null;
        throw error;
      }
    },
    async put(name, body, generation) {
      const url = new URL(`https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o`);
      url.searchParams.set('uploadType', 'media');
      url.searchParams.set('name', name);
      if (generation !== undefined) url.searchParams.set('ifGenerationMatch', generation);
      const response = await request(url, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/octet-stream' }, body,
      });
      return response.json();
    },
    async remove(name, generation) {
      await request(`${root}${encodeURIComponent(name)}?ifGenerationMatch=${generation}`, {
        method: 'DELETE', headers,
      });
    },
  };
}

async function packSession(profile, archive) {
  await exec('tar', [
    '--exclude=Singleton*', '--exclude=*/Cache', '--exclude=*/Code Cache',
    '--exclude=*/GPUCache', '-czf', `${archive}.tmp`, '-C', profile, '.',
  ]);
  await fs.chmod(`${archive}.tmp`, 0o600);
  await fs.rename(`${archive}.tmp`, archive);
}

function makeClient(profile) {
  const { Client, LocalAuth } = require('whatsapp-web.js');
  return new Client({
    authStrategy: new LocalAuth({ dataPath: profile }),
    webVersionCache: { type: 'none' },
    puppeteer: { headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] },
  });
}

async function connect(client, timeout = 75000, qrHandler) {
  const onLoading = percent => log('loading', { percent });
  const onAuthenticated = () => log('authenticated');
  let onReady;
  let onFailure;
  let onDisconnected;
  let onQr;
  try {
    await bounded(new Promise((resolve, reject) => {
      onReady = () => { log('ready'); resolve(); };
      onFailure = () => reject(new Error('Authentification refusee.'));
      onDisconnected = () => reject(new Error('Client deconnecte avant ready.'));
      onQr = code => {
        if (!qrHandler) return reject(new Error('Session expiree : aucun QR dans les logs Cloud Run.'));
        try { qrHandler(code); } catch (error) { reject(error); }
      };
      client.once('ready', onReady);
      client.once('auth_failure', onFailure);
      client.once('disconnected', onDisconnected);
      client.on('qr', onQr);
      client.on('loading_screen', onLoading);
      client.on('authenticated', onAuthenticated);
      Promise.resolve().then(() => client.initialize()).catch(reject);
    }), timeout);
  } finally {
    client.off('ready', onReady);
    client.off('auth_failure', onFailure);
    client.off('disconnected', onDisconnected);
    client.off('qr', onQr);
    client.off('loading_screen', onLoading);
    client.off('authenticated', onAuthenticated);
  }
}

async function waitUntil(start, now = Date.now, wait = sleep, guard = () => {}) {
  while (now() < start) {
    guard();
    await wait(Math.min(1000, start - now()));
  }
  guard();
}

async function acquireLock(store, key, details, end, now = Date.now, wait = sleep) {
  let waiting = false;
  while (now() < end) {
    try {
      const lock = await store.put(key, JSON.stringify(details), 0);
      log('session_locked', details);
      return lock;
    } catch (error) {
      if (error.status !== 412) throw error;
      if (!waiting) {
        log('waiting_for_session', details);
        waiting = true;
      }
      await wait(Math.min(1000, Math.max(0, end - now())));
    }
  }
  throw new Error('Creneau expire en attendant le verrou ; aucun envoi. Verifier les executions precedentes.');
}

async function publishOnce(store, key, details, publish, window, now = Date.now) {
  const permitted = () => {
    const instant = now();
    return instant >= window.start && instant < window.end;
  };
  if (!permitted()) return 'outside_window';
  let reservation;
  try {
    reservation = await store.put(key, JSON.stringify({
      ...details, status: 'pending', time: new Date(now()).toISOString(),
    }), 0);
  } catch (error) {
    if (error.status !== 412) throw error;
    return 'already_recorded';
  }
  if (!permitted()) {
    await store.put(key, JSON.stringify({ ...details, status: 'expired' }), reservation.generation);
    return 'outside_window';
  }
  const response = await publish();
  await store.put(key, JSON.stringify({
    ...details, status: 'call_completed', responseHasId: response?.responseHasId === true,
    time: new Date(now()).toISOString(),
  }), reservation.generation);
  return 'call_completed';
}

async function runSession({ store, sessionKey, lockKey, window, details }, action, {
  createClient = makeClient, now = Date.now, wait = sleep,
} = {}) {
  const lock = await acquireLock(store, lockKey, details, window.end, now, wait);
  let tmp;
  let client;
  let normal = false;
  let disconnected;
  const guard = () => { if (disconnected) throw disconnected; };
  const onDisconnected = () => {
    disconnected = new Error('Client deconnecte : verifier WhatsApp, aucun retry.');
    log('error', { ...details, stage: 'connection', message: disconnected.message });
  };
  try {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-cloud-poll-'));
    const archive = path.join(tmp, 'session.tar.gz');
    const profile = path.join(tmp, 'profile');
    const saved = await store.get(sessionKey);
    if (!saved) throw new Error(`Archive absente : ${sessionKey}.`);
    await fs.writeFile(archive, saved, { mode: 0o600 });
    await fs.mkdir(profile, { mode: 0o700 });
    await exec('tar', ['--no-same-owner', '-xzf', archive, '-C', profile]);
    client = createClient(profile);
    client.on('disconnected', onDisconnected);
    try {
      await connect(client, Math.max(1, Math.min(75000, window.end - now())));
      guard();
      if (now() < window.start) log('waiting_for_slot', details);
      await waitUntil(window.start, now, wait, guard);
      await action(client, guard);
      guard();
      normal = true;
    } finally {
      client.off('disconnected', onDisconnected);
      if (client.pupBrowser) await bounded(client.destroy(), 10000);
    }
    await bounded(packSession(profile, archive), 15000);
    await store.put(sessionKey, await fs.readFile(archive));
    log('session_saved', details);
    await store.remove(lockKey, lock.generation);
    log('done', details);
  } catch (error) {
    log('exercise_blocked', {
      ...details, message: 'Verrou conserve ; verifier WhatsApp. Aucun retry.',
      sendPhaseCompleted: normal,
    });
    throw error;
  } finally {
    if (tmp) await fs.rm(tmp, { recursive: true, force: true });
  }
}

module.exports = {
  log, bounded, request, metadataToken, storage, packSession, makeClient, connect,
  waitUntil, acquireLock, publishOnce, runSession,
};
