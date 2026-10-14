'use strict';

const path = require('node:path');
const { log, bounded, request, metadataToken, storage, makeClient, connect,
  packSession, publishOnce, runSession } = require('./lib/runtime.cjs');
const { sendPoll } = require('./lib/poll.cjs');

const DEFAULT_TITLE = 'TEST — Événement du {date} : présent ?';
const ZONE = 'Europe/Paris';

function dateAfter(days, now = new Date(), zone = ZONE) {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const p = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const date = new Date(`${p.year}-${p.month}-${p.day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function selectEvent(rows, date) {
  if (!Array.isArray(rows) || !Array.isArray(rows[0]) ||
    rows[0].slice(0, 3).map(String).join('|') !== 'Date|Actif|Titre') {
    throw new Error('En-têtes attendus dans Sheets : Date, Actif, Titre.');
  }
  if (rows.some(row => !Array.isArray(row))) throw new Error('Ligne Sheets invalide.');
  const active = rows.slice(1).filter(row => String(row[1]).trim().toUpperCase() === 'OUI');
  if (active.some(row => typeof row[0] !== 'string' || !validDate(row[0].trim()))) {
    throw new Error('Les dates actives doivent être du TEXTE valide au format AAAA-MM-JJ.');
  }
  const matches = active.filter(row => row[0].trim() === date);
  if (matches.length > 1) throw new Error(`Deux événements actifs pour ${date}.`);
  if (!matches.length) return null;
  const template = String(matches[0][2] || DEFAULT_TITLE);
  return { date, question: template.replaceAll('{date}', date.split('-').reverse().join('/')) };
}

function dailyWindow(now = new Date()) {
  const date = dateAfter(0, now);
  const utc = Date.parse(`${date}T09:00:00Z`);
  // Le decalage Paris est celui du jour vise, pas une constante ete/hiver.
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en', {
    timeZone: ZONE, hourCycle: 'h23', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(utc)).map(part => [part.type, part.value]));
  const offset = (Number(parts.hour) * 60 + Number(parts.minute) - 9 * 60) * 60000;
  const start = utc - offset;
  return { date, prepare: start - 180000, start, end: start + 900000 };
}

async function readSheet(token, env) {
  const credentials = await request(
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(env.SHEETS_READER)}:generateAccessToken`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: ['https://www.googleapis.com/auth/spreadsheets.readonly'], lifetime: '3600s',
      }),
    });
  const { accessToken } = await credentials.json();
  if (typeof accessToken !== 'string' || !accessToken) throw new Error('Jeton Sheets absent.');
  const response = await request(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(env.SPREADSHEET_ID)}/values/Evenements!A:C?valueRenderOption=UNFORMATTED_VALUE`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  const data = await response.json();
  return data.values === undefined ? [] : data.values;
}

function validateConfig(env) {
  for (const key of ['SPREADSHEET_ID', 'SHEETS_READER', 'STATE_BUCKET', 'GROUP_ID']) {
    if (typeof env[key] !== 'string' || !env[key].trim()) throw new Error(`Configuration manquante : ${key}`);
  }
  if (!/^[\d-]+@g\.us$/.test(env.GROUP_ID)) throw new Error('GROUP_ID doit identifier un groupe.');
  if (env.TIME_ZONE && env.TIME_ZONE !== ZONE) throw new Error('TIME_ZONE attendu : Europe/Paris.');
  if (env.LEAD_DAYS !== undefined && env.LEAD_DAYS !== '1') throw new Error('LEAD_DAYS attendu : 1 (événement du lendemain).');
  if (env.DRY_RUN !== undefined && !['true', 'false'].includes(env.DRY_RUN)) {
    throw new Error('DRY_RUN attendu : true ou false.');
  }
}

async function run(env = process.env, dependencies = {}) {
  validateConfig(env);
  const now = dependencies.now || Date.now;
  const reference = new Date(now());
  const window = dailyWindow(reference);
  const date = dateAfter(1, reference);
  const real = env.DRY_RUN === 'false';
  if (real && !env.CLOUD_RUN_JOB) throw new Error('Publication réelle réservée à un Cloud Run Job.');
  log('execution_started', { date, scheduledAt: new Date(window.start).toISOString() });
  if (real && (now() < window.prepare || now() >= window.end)) {
    return log('slot_skipped', { date, reason: 'outside_preparation_window' });
  }
  const token = await metadataToken();
  const event = selectEvent(await readSheet(token, env), date);
  if (!event) return log('no_event', { date });
  log('planned', event);
  if (!real) return log('dry_run', { date });
  const store = storage(env.STATE_BUCKET, token);
  const key = `polls/${env.GROUP_ID}/${date}.json`;
  const existing = await store.get(key);
  if (existing) {
    return log('already_recorded', { date, status: JSON.parse(existing.toString()).status });
  }
  await runSession({
    store, sessionKey: 'session.tar.gz', lockKey: 'lock.json', window,
    details: { date, execution: env.CLOUD_RUN_EXECUTION },
  }, async (client, guard) => {
    const Poll = dependencies.Poll || require('whatsapp-web.js').Poll;
    const status = await publishOnce(store, key, { date }, async () => {
      guard();
      const result = await bounded(sendPoll(client, Poll, env.GROUP_ID, {
        date, scheduledAt: new Date(window.start).toISOString(),
      }, event.question), 20000);
      guard();
      return result;
    }, window, now);
    log(status === 'outside_window' ? 'slot_skipped' : status, { date, reason: status });
  }, dependencies);
}

async function pair(env = process.env) {
  if (env.CLOUD_RUN_JOB || !process.stdout.isTTY) throw new Error('pair exige un terminal interactif hors Cloud Run.');
  const profile = path.join('/secrets', 'profile');
  const client = makeClient(profile);
  let ready = false;
  try {
    await connect(client, 180000, code => {
      log('scan_qr', { message: 'QR sensible : scanner sur Android, ne pas partager.' });
      require('qrcode-terminal').generate(code, { small: true });
    });
    ready = true;
  } finally {
    if (client.pupBrowser) await bounded(client.destroy(), 10000);
  }
  if (ready) {
    await packSession(profile, '/secrets/session.tar.gz');
    log('session_saved', { file: '/secrets/session.tar.gz' });
  }
}

async function main(mode = process.argv[2] || 'run', env = process.env) {
  if (mode === 'run') return run(env);
  if (mode === 'pair') return pair(env);
  if (mode === 'calendar') {
    const now = new Date();
    console.log('Date,Actif,Titre');
    for (let day = 1; day <= 365; day++) console.log(`${dateAfter(day, now)},OUI,${DEFAULT_TITLE}`);
    return;
  }
  throw new Error('Commande attendue : run, pair ou calendar. Le mode groups a été retiré.');
}

module.exports = { dateAfter, dailyWindow, selectEvent, readSheet, validateConfig, run, main };
if (require.main === module) {
  main().catch(error => {
    log('error', { message: error?.message || String(error), stage: error.stage });
    process.exitCode = 1;
  });
}
