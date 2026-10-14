'use strict';

const path = require('node:path');

function log(event, details = {}) {
  console.log(JSON.stringify({ event, ...details }));
}

function messageKey(message, groupId) {
  const id = message?.id;
  if (typeof id?._serialized === 'string' && id._serialized) return id._serialized;
  if (typeof id?.id === 'string' && id.id) return `${groupId}:${id.id}`;
  return null;
}

async function sendPoll(client, Poll, groupId, details = {}) {
  let stage = 'create_poll';
  try {
    const poll = new Poll('TEST : present ?', ['oui', 'non'], {
      allowMultipleAnswers: false,
    });
    stage = 'send_poll';
    const sent = await client.sendMessage(groupId, poll, {
      sendSeen: false, waitUntilMsgSent: true,
    });
    log('poll_send_completed', {
      ...details,
      responseHasId: messageKey(sent, groupId) !== null,
      message: 'Appel termine sans erreur ; verifier le sondage dans WhatsApp.',
    });
  } catch (error) {
    throw Object.assign(new Error(error?.message || String(error), { cause: error }), { stage });
  }
}

const SCHEDULE = ['10:10', '10:13', '10:16', '10:19'].map(time =>
  Date.parse(`2026-10-14T${time}:00+02:00`));
const SCHEDULE_END = Date.parse('2026-10-14T10:20:00+02:00');

function scheduledPublisher(client, Poll, groupId, now = Date.now) {
  let next = 0;
  let busy = false;
  let finished = false;
  return async function tick() {
    if (busy || finished) return finished;
    busy = true;
    try {
      while (next < SCHEDULE.length) {
        if (now() >= SCHEDULE_END) {
          log('schedule_finished', { reason: 'window_closed', remaining: SCHEDULE.length - next });
          finished = true;
          return true;
        }
        if (now() < SCHEDULE[next]) return false;
        const slot = SCHEDULE[next++];
        await sendPoll(client, Poll, groupId, { scheduledAt: new Date(slot).toISOString() });
      }
      log('schedule_finished', { reason: 'all_slots_attempted' });
      finished = true;
      return true;
    } catch (error) {
      finished = true;
      log('error', {
        stage: error.stage,
        message: error.message,
        action: 'Planning arrete ; verifier WhatsApp. Aucun retry automatique.',
      });
      return true;
    } finally {
      busy = false;
    }
  };
}

function attachPollHandler(client, Poll, groupId) {
  if (!/^[\d-]+@g\.us$/.test(groupId || '')) {
    throw new Error('Renseigner GROUP_ID avec un identifiant de groupe @g.us.');
  }
  let ready = false;
  let sending = false;
  const handled = new Set();
  client.on('ready', () => { ready = true; log('ready'); });
  client.on('disconnected', () => { ready = false; });

  // message_create inclut aussi les commandes envoyees depuis le compte du bot.
  client.on('message_create', message => {
    const destination = message.fromMe ? message.to : message.from;
    if (message.body !== '!sendpoll' || destination !== groupId) return;
    const id = messageKey(message, groupId);
    if (!id) {
      log('error', { message: 'Commande sans identifiant : aucun envoi.' });
      return;
    }
    if (handled.has(id)) return;
    if (!ready || sending) {
      log('command_rejected', { reason: ready ? 'sending_in_progress' : 'not_ready' });
      return;
    }
    handled.add(id);
    sending = true;
    void (async () => {
      try {
        await sendPoll(client, Poll, groupId);
      } catch (error) {
        log('error', {
          stage: error.stage,
          message: error?.message || String(error),
          action: 'Verifier WhatsApp avant toute nouvelle commande ; aucun retry automatique.',
        });
      } finally {
        sending = false;
      }
    })();
  });
}

async function main(env = process.env) {
  if (env.CLOUD_RUN_JOB || !process.stdout.isTTY) {
    throw new Error('Exemple interactif uniquement : lancer Docker avec -it, hors Cloud Run.');
  }
  if (!/^[\d-]+@g\.us$/.test(env.GROUP_ID || '')) {
    throw new Error('Renseigner GROUP_ID avec un identifiant de groupe @g.us.');
  }
  const mode = process.argv[2] || 'manual';
  if (!['manual', 'schedule'].includes(mode)) {
    throw new Error('Mode attendu : manual ou schedule.');
  }
  const { Client, LocalAuth, Poll } = require('whatsapp-web.js');
  const qr = require('qrcode-terminal');
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join('/secrets', 'profile') }),
    webVersionCache: { type: 'none' },
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    },
  });
  let scheduleTimer;
  let connected = false;
  if (mode === 'manual') {
    attachPollHandler(client, Poll, env.GROUP_ID);
  } else {
    const tick = scheduledPublisher(client, Poll, env.GROUP_ID);
    const runSchedule = async () => {
      if (!connected || stopping) return;
      if (await tick()) clearInterval(scheduleTimer);
    };
    client.on('ready', () => {
      connected = true;
      log('ready', { mode: 'schedule', timeZone: 'Europe/Paris', date: '2026-10-14' });
      if (!scheduleTimer) scheduleTimer = setInterval(() => { void runSchedule(); }, 1000);
      void runSchedule();
    });
    client.on('disconnected', () => { connected = false; });
  }
  client.on('qr', code => {
    log('scan_qr', { message: 'QR sensible : scanner sur Android, ne pas partager.' });
    qr.generate(code, { small: true });
  });
  client.on('loading_screen', percent => log('loading', { percent }));
  client.on('authenticated', () => log('authenticated'));
  let stopping = false;
  async function stop(failed) {
    if (failed) process.exitCode = 1;
    if (stopping) return;
    stopping = true;
    clearInterval(scheduleTimer);
    try {
      if (client.pupBrowser) await client.destroy();
      log('stopped');
    } catch (error) {
      process.exitCode = 1;
      log('error', { message: `Fermeture : ${error?.message || String(error)}` });
    }
  }
  process.once('SIGINT', () => { void stop(false); });
  process.once('SIGTERM', () => { void stop(false); });
  client.on('auth_failure', () => {
    log('error', { message: 'Authentification refusee.' });
    void stop(true);
  });
  client.on('disconnected', () => {
    log('error', { message: 'Client deconnecte : aucun redemarrage automatique.' });
    void stop(true);
  });
  try {
    await client.initialize();
  } catch (error) {
    log('error', { message: `Initialisation : ${error?.message || String(error)}` });
    await stop(true);
  }
}

module.exports = { attachPollHandler, messageKey, scheduledPublisher, sendPoll };
if (require.main === module) {
  main().catch(error => {
    log('error', { message: error?.message || String(error) });
    process.exitCode = 1;
  });
}
