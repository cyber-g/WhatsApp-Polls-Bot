'use strict';

// Tests natifs Node : ni npm install, ni compte Google, ni connexion WhatsApp.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const exec = require('node:util').promisify(require('node:child_process').execFile);
const { dateAfter, selectEvent, publishOnce, sendConfirmed, storage, packSession, run, main } = require('./bot.cjs');
const HEADER = ['Date', 'Actif', 'Titre'];
const ENV = {
  SPREADSHEET_ID: 'sheet', SHEETS_READER: 'reader', STATE_BUCKET: 'bucket',
  GROUP_ID: '123@g.us', GROUP_NAME: 'test', DRY_RUN: 'true',
};

// Faux stockage atomique : suffisant pour tester notre protection, pas GCS lui-même.
function fakeStore() {
  const files = new Map();
  return {
    files,
    async put(key, body, generation) {
      if (generation === 0 && files.has(key)) {
        throw Object.assign(new Error('existe'), { status: 412 });
      }
      files.set(key, JSON.parse(body));
      return { generation: '1' };
    },
  };
}

function fakeGoogle(t, values, rest = []) {
  const calls = [];
  const responses = [
    { access_token: 'token-factice' }, { accessToken: 'sheets-factice' }, { values }, ...rest,
  ];
  t.mock.method(console, 'log', () => {});
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), options });
    const result = responses.shift();
    assert.notEqual(result, undefined, 'Appel réseau supplémentaire inattendu');
    if (result instanceof Response) return result;
    return new Response(JSON.stringify(result));
  });
  return calls;
}

test('demain à Paris, indépendamment du fuseau du serveur', () => {
  assert.equal(dateAfter(1, new Date('2026-10-13T23:30:00Z')), '2026-10-15');
  assert.equal(dateAfter(1, new Date('2026-10-13T23:30:00Z'), 'UTC'), '2026-10-14');
});

test('jours calendaires aux changements d’heure et d’année, y compris année bissextile', () => {
  assert.equal(dateAfter(1, new Date('2026-03-28T22:30:00Z')), '2026-03-29');
  assert.equal(dateAfter(1, new Date('2026-03-29T22:30:00Z')), '2026-03-31');
  assert.equal(dateAfter(1, new Date('2026-10-25T22:30:00Z')), '2026-10-26');
  assert.equal(dateAfter(1, new Date('2026-12-31T12:00:00Z')), '2027-01-01');
  assert.equal(dateAfter(1, new Date('2028-02-28T12:00:00Z')), '2028-02-29');
  assert.equal(dateAfter(2, new Date('2026-10-14T07:00:00Z')), '2026-10-16');
});

test('titre personnalisé et remplacement de la date', () => {
  assert.deepEqual(selectEvent([HEADER, ['2026-10-16', 'OUI', 'Préparation Dan du {date}']], '2026-10-16'), {
    date: '2026-10-16', question: 'Préparation Dan du 16/10/2026',
  });
});

test('titre de test par défaut et dates inactives ou absentes', () => {
  assert.equal(selectEvent([HEADER, ['2026-10-16', ' oui ']], '2026-10-16').question,
    'TEST — Événement du 16/10/2026 : présent ?');
  assert.equal(selectEvent([HEADER, ['2026-10-16', 'NON']], '2026-10-16'), null);
  assert.equal(selectEvent([HEADER], '2026-10-16'), null);
});

test('refus des doubles événements actifs, mauvais en-têtes et dates converties', () => {
  const row = ['2026-10-16', 'OUI'];
  assert.throws(() => selectEvent([HEADER, row, row], '2026-10-16'), /Deux événements/);
  assert.throws(() => selectEvent([], '2026-10-16'), /En-têtes/);
  assert.throws(() => selectEvent([HEADER, [46311, 'OUI']], '2026-10-16'), /TEXTE/);
  assert.throws(() => selectEvent([HEADER, ['16\/10\/2026', 'OUI']], '2026-10-16'), /TEXTE/);
});

test('marqueur posé avant envoi ; deux tentatives simultanées ne publient qu’une fois', async () => {
  const store = fakeStore();
  let sends = 0;
  const send = async () => {
    assert.equal(store.files.get('day').status, 'pending');
    sends++;
    return 'message-123';
  };
  const results = await Promise.all([publishOnce(store, 'day', send), publishOnce(store, 'day', send)]);
  assert.equal(sends, 1);
  assert.deepEqual(results.sort(), ['already_recorded', 'sent']);
  assert.equal(store.files.get('day').messageId, 'message-123');
});

test('une tentative incertaine reste pending et n’est pas rejouée', async () => {
  const store = fakeStore();
  await assert.rejects(publishOnce(store, 'day', async () => { throw new Error('réseau'); }), /réseau/);
  assert.equal(store.files.get('day').status, 'pending');
  assert.equal(await publishOnce(store, 'day', () => assert.fail('ne pas renvoyer')), 'already_recorded');
});

test('une erreur de permission n’est pas considérée comme un doublon', async () => {
  const store = { put: async () => { throw Object.assign(new Error('interdit'), { status: 403 }); } };
  await assert.rejects(publishOnce(store, 'day', () => assert.fail('ne pas envoyer')), /interdit/);
});

test('confirmation serveur reçue avant le retour de sendMessage ; nettoyage des listeners', async () => {
  const client = new EventEmitter();
  const message = { id: { _serialized: 'message' }, ack: 0 };
  client.sendMessage = async (group, poll, options) => {
    assert.equal(options.sendSeen, false);
    client.emit('message_ack', message, 1);
    return message;
  };
  assert.equal(await sendConfirmed(client, '123@g.us', {}), 'message');
  assert.equal(client.listenerCount('message_ack'), 0);
});

test('refus serveur ou absence de message : erreur, pas de succès fictif', async () => {
  const client = new EventEmitter();
  client.sendMessage = async () => ({ id: { _serialized: 'message' }, ack: -1 });
  await assert.rejects(sendConfirmed(client, '123@g.us', {}), /refuse/);
  client.sendMessage = async () => undefined;
  await assert.rejects(sendConfirmed(client, '123@g.us', {}), /renvoie pas/);
  assert.equal(client.listenerCount('message_ack'), 0);
});

test('préconditions et encodage des objets transmis à GCS', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: new URL(url), options });
    return new Response(JSON.stringify({ generation: '321' }));
  });
  const store = storage('bucket', 'token-factice');
  await store.put('polls/123@g.us/2026-10-16.json', '{}', 0);
  await store.remove('lock.json', '321');
  assert.equal(calls[0].url.searchParams.get('ifGenerationMatch'), '0');
  assert.equal(calls[0].url.searchParams.get('name'), 'polls/123@g.us/2026-10-16.json');
  assert.equal(calls[1].url.searchParams.get('ifGenerationMatch'), '321');
  assert.equal(calls[1].options.method, 'DELETE');
});

test('un objet absent est distinct d’un objet inaccessible', async t => {
  const mock = t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 404 }));
  const store = storage('bucket', 'token-factice');
  assert.equal(await store.get('absent'), null);
  mock.mock.mockImplementation(async () => new Response('', { status: 403 }));
  await assert.rejects(store.get('interdit'), /HTTP 403/);
});

test('simulation : lecture Sheets privée, pas de stockage ni de navigateur', async t => {
  const calls = fakeGoogle(t, [HEADER, [dateAfter(1), 'OUI']]);
  await run(ENV);
  assert.equal(calls.length, 3);
  assert.match(calls[2].url, /valueRenderOption=UNFORMATTED_VALUE/);
  assert.deepEqual(JSON.parse(calls[1].options.body).scope,
    ['https://www.googleapis.com/auth/spreadsheets.readonly']);
  assert.equal(calls[2].options.headers.Authorization, 'Bearer sheets-factice');
});

test('sans DRY_RUN explicite, le comportement reste la simulation', async t => {
  const calls = fakeGoogle(t, [HEADER, [dateAfter(1), 'OUI']]);
  await run({ ...ENV, DRY_RUN: undefined });
  assert.equal(calls.length, 3);
});

test('aucun événement : pas de stockage ni de navigateur, même en mode réel', async t => {
  const calls = fakeGoogle(t, [HEADER]);
  await run({ ...ENV, DRY_RUN: 'false' });
  assert.equal(calls.length, 3);
});

test('déjà enregistré : pas de nouvelle connexion WhatsApp ni de verrou supplémentaire', async t => {
  const calls = fakeGoogle(t, [HEADER, [dateAfter(1), 'OUI']], [{ status: 'pending' }]);
  await run({ ...ENV, DRY_RUN: 'false' });
  assert.equal(calls.length, 4);
});

test('verrou occupé : arrêt explicite avant de lire la session', async t => {
  const calls = fakeGoogle(t, [HEADER, [dateAfter(1), 'OUI']], [
    new Response('', { status: 404 }), new Response('', { status: 412 }),
  ]);
  await assert.rejects(run({ ...ENV, DRY_RUN: 'false' }), /Verrou présent/);
  assert.equal(calls.length, 5);
});

test('mauvaise configuration refusée avant tout réseau', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('aucun réseau attendu'));
  await assert.rejects(run({}), /Configuration manquante/);
  await assert.rejects(run({ ...ENV, GROUP_ID: '123@c.us' }), /groupe/);
  await assert.rejects(run({ ...ENV, LEAD_DAYS: 'abc' }), /LEAD_DAYS/);
});

test('archive privée : données conservées, caches/verrous exclus, extraction possible', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-test-'));
  try {
    const profile = path.join(tmp, 'profile');
    await fs.mkdir(path.join(profile, 'session', 'Default', 'Cache'), { recursive: true });
    await fs.writeFile(path.join(profile, 'session', 'Default', 'Cache', 'cache'), 'inutile');
    await fs.writeFile(path.join(profile, 'session', 'Default', 'IndexedDB'), 'session-factice');
    await fs.symlink('ancien-hote-123', path.join(profile, 'session', 'SingletonLock'));
    const archive = path.join(tmp, 'session.tar.gz');
    await packSession(profile, archive);
    const { stdout } = await exec('tar', ['-tzf', archive]);
    assert.match(stdout, /IndexedDB/);
    assert.doesNotMatch(stdout, /Singleton|Cache/);
    assert.equal((await fs.stat(archive)).mode & 0o777, 0o600);
    await fs.mkdir(path.join(tmp, 'restore'));
    await exec('tar', ['--no-same-owner', '-xzf', archive, '-C', path.join(tmp, 'restore')]);
    assert.equal(await fs.readFile(path.join(tmp, 'restore/session/Default/IndexedDB'), 'utf8'), 'session-factice');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('générateur : 365 événements explicites ; commande inconnue refusée', async t => {
  const lines = [];
  t.mock.method(console, 'log', line => lines.push(line));
  await main('calendar');
  assert.equal(lines.length, 366);
  assert.equal(lines[0], 'Date,Actif,Titre');
  assert.equal(new Set(lines.slice(1).map(line => line.split(',')[0])).size, 365);
  assert.match(lines[1], /^\d{4}-\d{2}-\d{2},OUI,TEST/);
  await assert.rejects(main('autre'), /Commande attendue/);
});
