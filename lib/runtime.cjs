'use strict';

const fs = require('node:fs/promises');
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

async function connect(client, timeout = 75000) {
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
      onQr = () => reject(new Error('Session expiree : aucun QR dans les logs Cloud Run.'));
      client.once('ready', onReady);
      client.once('auth_failure', onFailure);
      client.once('disconnected', onDisconnected);
      client.once('qr', onQr);
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

module.exports = { log, bounded, request, metadataToken, storage, packSession, makeClient, connect };
