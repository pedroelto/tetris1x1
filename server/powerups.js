// Power-up disputado: EXCLUSÃO MÚTUA CENTRALIZADA (algoritmo do coordenador).
//
// O power-up é um recurso único. O servidor é o coordenador: os dois clientes
// podem PEDIR (powerup_claim), mas só o coordenador decide quem recebe.
// Os pedidos são atendidos na ordem em que chegam; o primeiro pedido válido
// leva o recurso e todos os seguintes são negados.
//
// Estado guardado no servidor:
//   room.powerup      = { id, type, spawnedAt, expiresAt, grantedTo } | null
//   room.powerupTimer = timer do próximo surgimento OU da expiração
//   room.pastPowerupIds = ids que já existiram nesta partida (para responder "expirado")
//   player.effect     = 'escudo' | 'dobro' | null   (no máximo um por jogador)
//   player.lastLock   = { linesCleared, at }         último piece_locked aceito

import { SERVER_EVENTS as S, ROOM_STATES } from '../shared/protocol.js';
import { POWERUP_TYPES, POWERUP_MIN_LINES, DENY_REASONS } from '../shared/powerups.js';
import { send, broadcast } from './messaging.js';
import { logEvent } from './logger.js';
import { config } from './config.js';

// Os tempos podem ser sobrescritos por variável de ambiente (ver config.js).
const SPAWN_MIN_MS = config.powerupSpawnMinMs;
const SPAWN_MAX_MS = config.powerupSpawnMaxMs;
const DURATION_MS = config.powerupDurationMs;

let nextPowerupId = 1; // global: um id nunca se repete, nem entre partidas

const log = (player, room, text, data) => logEvent('POWERUP', player ?? { id: '--', room }, text, data);

// ---------- Ciclo de vida ----------

// Zera tudo (fim de partida, "jogar de novo", início de partida).
export function resetPowerups(room) {
  clearTimeout(room.powerupTimer);
  room.powerupTimer = null;
  room.powerup = null;
  room.pastPowerupIds = new Set();
  for (const p of room.players) {
    p.effect = null;
    p.lastLock = null;
  }
}

// Partida pausada: o power-up ativo é cancelado (avisado como expirado) e o
// timer de surgimento para. Os efeitos já ganhos (player.effect) são mantidos.
// Na retomada, o timer recomeça do zero (schedulePowerup ao voltar a "jogando").
export function pausePowerups(room) {
  clearTimeout(room.powerupTimer);
  room.powerupTimer = null;
  const powerup = room.powerup;
  room.powerup = null;
  if (powerup && !powerup.grantedTo) {
    log(null, room, `${powerup.id} cancelado: partida pausada`);
    broadcast(room, S.POWERUP_EXPIRED, { id: powerup.id });
  }
}

// Agenda o próximo surgimento para daqui a um tempo aleatório entre MIN e MAX.
export function schedulePowerup(room) {
  const delay = SPAWN_MIN_MS + Math.random() * (SPAWN_MAX_MS - SPAWN_MIN_MS);
  room.powerupTimer = setTimeout(() => spawnPowerup(room), delay);
}

// Ferramenta de demonstração (monitor): faz o power-up surgir AGORA, em vez de
// esperar o intervalo aleatório. Usa o mesmo spawnPowerup do jogo normal.
// Devolve null se deu certo, ou o motivo da recusa.
export function forcePowerup(room) {
  if (room.state !== ROOM_STATES.PLAYING) return 'a sala não está em "jogando"';
  if (room.powerup && !room.powerup.grantedTo) return `já existe um power-up ativo (${room.powerup.id})`;
  clearTimeout(room.powerupTimer);
  log(null, room, 'surgimento forçado pelo monitor');
  spawnPowerup(room);
  return null;
}

function spawnPowerup(room) {
  if (room.state !== ROOM_STATES.PLAYING) return;

  const types = Object.values(POWERUP_TYPES);
  const now = Date.now();
  room.powerup = {
    id: `PU${nextPowerupId++}`,
    type: types[Math.floor(Math.random() * types.length)],
    spawnedAt: now,
    expiresAt: now + DURATION_MS,
    grantedTo: null,
  };
  room.pastPowerupIds.add(room.powerup.id);
  const { id, type, expiresAt } = room.powerup;

  log(null, room, `surgiu ${id} (${type}), expira em ${DURATION_MS}ms`);
  broadcast(room, S.POWERUP_SPAWN, { id, type, expiresAt });
  room.powerupTimer = setTimeout(() => expirePowerup(room), DURATION_MS);
}

function expirePowerup(room) {
  const powerup = room.powerup;
  if (!powerup || powerup.grantedTo) return;
  room.powerup = null;
  log(null, room, `${powerup.id} expirou sem ninguém pegar`);
  broadcast(room, S.POWERUP_EXPIRED, { id: powerup.id });
  schedulePowerup(room);
}

// Chamado a cada piece_locked aceito: guarda o que o jogador acabou de fazer.
export function recordLock(player, linesCleared) {
  player.lastLock = { linesCleared, at: Date.now() };
}

// ---------- Pedido do recurso (o coração da exclusão mútua) ----------

export function claimPowerup(player, powerupId, seq) {
  const room = player.room;
  const powerup = room.powerup;

  // >>> SEÇÃO CRÍTICA <<<
  // Do primeiro teste até `powerup.grantedTo = player` NÃO há nenhum `await`,
  // callback ou E/S. Como o Node executa um handler por vez (laço de eventos
  // de thread única), nenhum outro pedido pode ser processado no meio desta
  // verificação. Isso torna "verificar se está livre" + "marcar como dono"
  // uma operação ATÔMICA: é impossível os dois jogadores receberem o recurso.
  let reason = null;
  if (!powerup || powerup.id !== powerupId) {
    reason = room.pastPowerupIds.has(powerupId) ? DENY_REASONS.EXPIRED : DENY_REASONS.UNKNOWN;
  } else if (powerup.grantedTo) {
    reason = powerup.grantedTo === player ? DENY_REASONS.ALREADY_YOURS : DENY_REASONS.TAKEN;
  } else if (!player.lastLock || player.lastLock.at < powerup.spawnedAt ||
             player.lastLock.linesCleared < POWERUP_MIN_LINES) {
    reason = DENY_REASONS.INVALID;
  }

  if (reason) {
    log(player, room, `pedido de ${powerupId} NEGADO: ${reason}`, { seq });
    send(player, S.POWERUP_DENIED, { id: powerupId, reason });
    return;
  }

  powerup.grantedTo = player; // a partir daqui o recurso tem dono
  // >>> FIM DA SEÇÃO CRÍTICA <<<

  clearTimeout(room.powerupTimer); // não expira mais
  const replaced = player.effect ? ` (substitui ${player.effect})` : '';
  player.effect = powerup.type;
  log(player, room, `pedido de ${powerup.id} ACEITO: ${player.nickname} ganhou ${powerup.type}${replaced}`, { seq });

  send(player, S.POWERUP_GRANTED, { id: powerup.id, type: powerup.type });
  const opponent = room.players.find((p) => p !== player);
  if (opponent) send(opponent, S.POWERUP_TAKEN, { id: powerup.id, byNickname: player.nickname });

  schedulePowerup(room); // próximo power-up
}

// ---------- Efeitos (aplicados pelo servidor no cálculo do ataque) ----------

export function hasEffect(player, type) {
  return player.effect === type;
}

export function consumeEffect(player, detail) {
  const type = player.effect;
  player.effect = null;
  log(player, player.room, `efeito ${type} consumido: ${detail}`);
  send(player, S.POWERUP_CONSUMED, { type, detail });
}
