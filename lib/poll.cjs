'use strict';

const { log } = require('./runtime.cjs');

function messageKey(message, groupId) {
  const id = message?.id;
  if (typeof id?._serialized === 'string' && id._serialized) return id._serialized;
  if (typeof id?.id === 'string' && id.id) return `${groupId}:${id.id}`;
  return null;
}

async function sendPoll(client, Poll, groupId, details = {}, question = 'TEST : present ?') {
  let stage = 'create_poll';
  try {
    const poll = new Poll(question, ['oui', 'non'], { allowMultipleAnswers: false });
    stage = 'send_poll';
    const sent = await client.sendMessage(groupId, poll, {
      sendSeen: false, waitUntilMsgSent: true,
    });
    const responseHasId = messageKey(sent, groupId) !== null;
    log('poll_send_completed', {
      ...details, responseHasId,
      message: 'Appel termine sans erreur ; verifier le sondage dans WhatsApp.',
    });
    return { responseHasId };
  } catch (error) {
    throw Object.assign(new Error(error?.message || String(error), { cause: error }), { stage });
  }
}

module.exports = { messageKey, sendPoll };
