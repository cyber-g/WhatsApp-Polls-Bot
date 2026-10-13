'use strict';

// Image d'outils : drdpham/whatsapp-webjs. Ce fichier est monté dans /app.
// Un passage = un événement à venir, éventuellement un sondage, puis arrêt.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');
const exec = promisify(execFile);
const DEFAULT_TITLE = 'TEST — Événement du {date} : présent ?';

function log(event, details = {}) {
  console.log(JSON.stringify({
    time: new Date().toISOString(),
    severity: event === 'error' ? 'ERROR' : 'INFO',
    event,
    ...details,
  }));
}

// Intl gère le fuseau. Ajouter des JOURS CALENDAIRES plutôt que 24 heures évite
// les décalages aux changements d'heure. Pas besoin de Luxon pour ce seul calcul.
function dateAfter(days, now = new Date(), zone = 'Europe/Paris') {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const p = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const date = new Date(`${p.year}-${p.month}-${p.day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function selectEvent(rows, date) {
  if (rows[0]?.slice(0, 3).map(String).join('|') !== 'Date|Actif|Titre') {
    throw new Error('En-têtes attendus dans Sheets : Date, Actif, Titre.');
  }
  const active = rows.slice(1).filter(row =>
    String(row[1]).trim().toUpperCase() === 'OUI');
  // Une date Sheets convertie en nombre ne doit pas passer pour « aucun événement ».
  if (active.some(row => !/^\d{4}-\d{2}-\d{2}$/.test(String(row[0]).trim()))) {
    throw new Error('Les dates actives doivent être du TEXTE au format AAAA-MM-JJ.');
  }
  const matches = active.filter(row => String(row[0]).trim() === date);
  if (matches.length > 1) throw new Error(`Deux événements actifs pour ${date}.`);
  if (!matches.length) return null;
  const template = String(matches[0][2] || DEFAULT_TITLE);
  return {
    date,
    question: template.replaceAll('{date}', date.split('-').reverse().join('/')),
  };
}

async function within(promise, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Délai dépassé.')), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Aucune nouvelle tentative implicite : une réponse perdue peut cacher un succès.
async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(60000) });
  if (!response.ok) {
    // Ne pas copier les jetons ni les réponses Google dans les logs.
    throw Object.assign(new Error(`HTTP ${response.status} — ${new URL(url).hostname}`), {
      status: response.status,
    });
  }
  return response;
}

async function readSheet(token, env) {
  // Le jeton natif Cloud Run porte le scope cloud-platform, pas celui de Sheets.
  // IAM crée donc un jeton temporaire pour le lecteur : aucune clé privée JSON.
  const credentials = await request(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${env.SHEETS_READER}:generateAccessToken`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: ['https://www.googleapis.com/auth/spreadsheets.readonly'], lifetime: '3600s',
      }),
    });
  const { accessToken } = await credentials.json();
  const response = await request(
    `https://sheets.googleapis.com/v4/spreadsheets/${env.SPREADSHEET_ID}/values/Evenements!A:C?valueRenderOption=UNFORMATTED_VALUE`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  return (await response.json()).values || [];
}

// L'état passe par l'API GCS, pas par FUSE : les préconditions sont atomiques.
// generation=0 : créer seulement si absent ; une autre valeur protège une version.
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

async function publishOnce(store, key, send) {
  let reservation;
  try {
    reservation = await store.put(key, JSON.stringify({
      status: 'pending', time: new Date().toISOString(),
    }), 0);
  } catch (error) {
    if (error.status === 412) return 'already_recorded';
    throw error;
  }
  // En cas d'incertitude, pending reste présent : vérifier WhatsApp avant de réessayer.
  const messageId = await send();
  await store.put(key, JSON.stringify({
    status: 'sent', messageId, time: new Date().toISOString(),
  }), reservation.generation);
  return 'sent';
}

async function sendConfirmed(client, group, poll) {
  const acks = new Map();
  const onAck = (message, ack) => acks.set(message.id._serialized, ack);
  client.on('message_ack', onAck);
  try {
    const message = await within(client.sendMessage(group, poll, {
      sendSeen: false, waitUntilMsgSent: true,
    }), 60000);
    if (!message?.id?._serialized) throw new Error('WhatsApp ne renvoie pas de message.');
    // L'ACK peut précéder le retour de sendMessage. >=1 signifie accepté par le
    // serveur, pas nécessairement livré ou lu par les membres du groupe.
    for (let attempt = 0; attempt < 30; attempt++) {
      const ack = acks.get(message.id._serialized) ?? message.ack;
      if (ack >= 1) return message.id._serialized;
      if (ack === -1) throw new Error('WhatsApp refuse le sondage.');
      await sleep(1000);
    }
    throw new Error('Envoi incertain : aucune confirmation serveur.');
  } finally {
    client.off('message_ack', onAck);
  }
}

async function packSession(profile, archive) {
  // Chrome doit être fermé. On conserve l'authentification, pas les verrous liés
  // à l'ancien conteneur ni les caches reconstruits par le navigateur.
  await exec('tar', [
    '--exclude=Singleton*', '--exclude=*/Cache', '--exclude=*/Code Cache',
    '--exclude=*/GPUCache', '-czf', `${archive}.tmp`, '-C', profile, '.',
  ]);
  await fs.chmod(`${archive}.tmp`, 0o600);
  await fs.rename(`${archive}.tmp`, archive);
}

function makeClient(profile) {
  // Ces deux packages sont déjà installés dans l'image, via NODE_PATH.
  const { Client, LocalAuth } = require('whatsapp-web.js');
  return new Client({
    authStrategy: new LocalAuth({ dataPath: profile }),
    webVersionCache: { type: 'none' }, // /app est monté en lecture seule.
    puppeteer: {
      headless: true,
      // Puppeteer retrouve son Chrome dans /opt/puppeteer, fourni par l'image.
      // Pas de navigateur à télécharger et pas de chemin Alpine à imposer.
      // Le sandbox Chrome est désactivé : on garde l'utilisateur non-root et
      // l'isolation du conteneur ; ce navigateur ne sert qu'à WhatsApp Web.
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    },
  });
}

async function connect(client, pairing) {
  await within(new Promise((resolve, reject) => {
    client.once('ready', resolve);
    client.once('auth_failure', () => reject(new Error('Authentification WhatsApp refusée.')));
    client.once('disconnected', () => reject(new Error('WhatsApp déconnecté.')));
    client.on('qr', qr => {
      if (pairing) require('qrcode-terminal').generate(qr, { small: true });
      else reject(new Error('Session expirée : refaire pair. Aucun QR dans les logs cloud.'));
    });
    client.initialize().catch(reject);
  }), 180000);
  // Laisser une petite marge de synchronisation avant de fermer/exporter le profil.
  await sleep(5000);
}

async function getGroups(client) {
  let groups;
  try {
    // getChats/getChatById sérialisent aussi messages et métadonnées : ils peuvent
    // échouer avec wwebjs 1.34.7. Seuls le nom et l'identifiant nous sont utiles.
    groups = await within(client.pupPage.evaluate(() => {
      const chats = window.require('WAWebCollections').Chat.getModelsArray();
      return chats.filter(chat => chat.groupMetadata).map(chat => ({
        id: chat.id.toString(), name: chat.formattedTitle,
      }));
    }), 30000);
  } catch (error) {
    throw new Error(`Lecture des groupes impossible : ${error?.message || String(error)}`, {
      cause: error,
    });
  }
  if (!Array.isArray(groups)) {
    throw new Error('Format des groupes WhatsApp incompatible : liste absente, aucun envoi autorisé.');
  }
  const invalid = [];
  for (const [index, group] of groups.entries()) {
    const validId = typeof group?.id === 'string' && /^[\d-]+@g\.us$/.test(group.id);
    const validName = typeof group?.name === 'string';
    if (!validId || !validName) {
      invalid.push(`index=${index}, idValide=${validId}, typeNom=${typeof group?.name}`);
      if (invalid.length === 3) break;
    }
  }
  if (invalid.length) {
    throw new Error(`Format des groupes WhatsApp incompatible : ${invalid.join(' ; ')}. Aucun envoi autorisé.`);
  }
  const unnamed = groups.filter(group => !group.name.trim()).length;
  if (unnamed) log('groups_without_name', { severity: 'WARNING', count: unnamed });
  return groups;
}

async function checkGroup(client, id, name) {
  const group = (await getGroups(client)).find(group => group.id === id);
  if (!group || !group.name.trim() || group.name !== name) {
    throw new Error('Groupe incorrect : vérifier GROUP_ID et GROUP_NAME. Aucun envoi.');
  }
}

async function pairSession(client, profile, archive, pairing = true) {
  let ready = false;
  try {
    await connect(client, pairing);
    ready = true;
    const groups = await getGroups(client);
    console.table(groups.map(group => ({
      nom: group.name.trim() ? group.name : '(nom indisponible)', GROUP_ID: group.id,
    })));
  } finally {
    if (client.pupBrowser) await within(client.destroy(), 15000);
    // Une erreur de lecture ne doit pas perdre un appairage déjà réussi.
    // L'erreur reste propagée ; session_saved ne signifie pas que pair a réussi.
    if (ready) {
      await fs.mkdir(path.dirname(archive), { recursive: true });
      await packSession(profile, archive);
      await fs.rm(profile, { recursive: true, force: true });
      log('session_saved', { file: archive });
    }
  }
}

async function localSession(pairing) {
  if (process.env.CLOUD_RUN_JOB || !process.stdout.isTTY) {
    throw new Error(`${pairing ? 'pair' : 'groups'} exige un terminal interactif, jamais une exécution Cloud Run.`);
  }
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-profile-'));
  const archive = '/secrets/session.tar.gz';
  if (!pairing) {
    await exec('tar', ['--no-same-owner', '-xzf', archive, '-C', profile]);
  }
  const client = makeClient(profile);
  // /secrets est le montage de .local/ sur le poste, jamais un dossier de l'image.
  await pairSession(client, profile, archive, pairing);
}

async function run(env = process.env) {
  for (const key of ['SPREADSHEET_ID', 'SHEETS_READER', 'STATE_BUCKET', 'GROUP_ID', 'GROUP_NAME']) {
    if (!env[key]) throw new Error(`Configuration manquante : ${key}`);
  }
  if (!/^[\d-]+@g\.us$/.test(env.GROUP_ID)) throw new Error('GROUP_ID doit identifier un groupe.');
  const days = Number(env.LEAD_DAYS ?? 1);
  if (!Number.isInteger(days) || days < 1) throw new Error('LEAD_DAYS doit être un entier positif.');
  const targetDate = dateAfter(days, new Date(), env.TIME_ZONE || 'Europe/Paris');
  const response = await request(
    'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' } });
  const { access_token: token } = await response.json();
  const event = selectEvent(await readSheet(token, env), targetDate);
  if (!event) return log('no_event', { date: targetDate });
  log('planned', event);
  // Seule la valeur exacte false autorise l'envoi. Simulation = pas de navigateur.
  if (env.DRY_RUN !== 'false') return log('dry_run');

  const store = storage(env.STATE_BUCKET, token);
  const key = `polls/${env.GROUP_ID}/${event.date}.json`;
  const existing = await store.get(key);
  if (existing) return log('already_recorded', {
    date: event.date, status: JSON.parse(existing.toString()).status,
  });

  let lock;
  try {
    // tasks=1 ne suffit pas à empêcher DEUX exécutions distinctes du job.
    lock = await store.put('lock.json', JSON.stringify({ time: new Date().toISOString() }), 0);
  } catch (error) {
    if (error.status === 412) throw new Error('Verrou présent : consulter EXPLOITATION.md.');
    throw error;
  }
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-profile-'));
  const archive = path.join(os.tmpdir(), 'session.tar.gz');
  const savedSession = await store.get('session.tar.gz');
  if (!savedSession) throw new Error('session.tar.gz absente du bucket état : refaire pair.');
  await fs.writeFile(archive, savedSession, { mode: 0o600 });
  await exec('tar', ['--no-same-owner', '-xzf', archive, '-C', profile]);
  const client = makeClient(profile);
  let ready = false;
  try {
    await connect(client, false);
    ready = true;
    await checkGroup(client, env.GROUP_ID, env.GROUP_NAME);
    const { Poll } = require('whatsapp-web.js');
    const poll = new Poll(event.question, ['oui', 'non'], { allowMultipleAnswers: false });
    const status = await publishOnce(store, key, () => sendConfirmed(client, env.GROUP_ID, poll));
    log(status, { date: event.date });
  } finally {
    // destroy ferme le navigateur ; logout révoquerait la session !
    if (client.pupBrowser) await within(client.destroy(), 15000);
    if (ready) {
      await packSession(profile, archive);
      await store.put('session.tar.gz', await fs.readFile(archive));
      log('session_saved');
    }
  }
  // Libérer seulement après une fin NORMALE et une sauvegarde réussie.
  // En cas d'erreur le verrou reste présent : déblocage manuel, pas de retry aveugle.
  await store.remove('lock.json', lock.generation);
  await fs.rm(profile, { recursive: true, force: true });
  await fs.rm(archive, { force: true });
  log('done');
}

async function main(mode = process.argv[2] || 'run') {
  if (mode === 'pair') return localSession(true);
  if (mode === 'groups') return localSession(false);
  if (mode === 'calendar') {
    const now = new Date(); // Une date de référence, même si minuit passe pendant la boucle.
    console.log('Date,Actif,Titre');
    for (let day = 1; day <= 365; day++) {
      console.log(`${dateAfter(day, now, process.env.TIME_ZONE || 'Europe/Paris')},OUI,${DEFAULT_TITLE}`);
    }
    return;
  }
  if (mode !== 'run') throw new Error('Commande attendue : run, pair, groups ou calendar.');
  await run();
}

// Importer ce fichier pour les tests ne déclenche ni réseau, ni navigateur.
module.exports = {
  dateAfter, selectEvent, publishOnce, sendConfirmed, storage, packSession,
  getGroups, checkGroup, pairSession, run, main,
};
if (require.main === module) {
  main().catch(error => {
    log('error', { message: error?.message || String(error) });
    process.exit(1);
  });
}
