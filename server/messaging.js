// Envio de mensagens do servidor, sempre registrando no log.

import { logEvent } from './logger.js';

// Jogador desconectado (aguardando reconexão) não recebe nada; o que ele
// perdeu chega depois, resumido no state_sync.
export function send(player, eventName, data) {
  if (!player.connected) {
    logEvent('NAO_ENVIADO', player, eventName, data, 'jogador desconectado');
    return;
  }
  logEvent('ENVIADO', player, eventName, data);
  player.socket.emit(eventName, data);
}

export function broadcast(room, eventName, data) {
  for (const p of room.players) send(p, eventName, data);
}

// Recusa um evento que chegou num estado em que não faz sentido.
export function reject(player, eventName, reason) {
  logEvent('DESCARTADO', player, eventName, null, reason);
}
