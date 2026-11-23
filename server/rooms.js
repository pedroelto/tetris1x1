// Salas 1v1. O servidor é a autoridade: só ele muda o estado da sala,
// gera a semente, marca o início da partida e decide o vencedor.
// Todo o estado fica em memória (Map), sem banco de dados.

import { randomUUID } from 'node:crypto';
import {
  CLIENT_EVENTS as C, SERVER_EVENTS as S, ROOM_STATES,
  MAX_PLAYERS, COUNTDOWN_MS,
} from '../shared/protocol.js';
import { ROWS, COLS } from '../shared/constants.js';
import { PIECE_TYPES } from '../shared/pieces.js';
import { randomSeed } from '../shared/random.js';
import { pushGarbage } from '../shared/engine.js';
import { attackFor, MAX_LINES_CLEARED } from '../shared/garbage.js';
import { POWERUP_TYPES } from '../shared/powerups.js';
import { logEvent } from './logger.js';
import { send, broadcast, reject } from './messaging.js';
import { config } from './config.js';
import { createEntry, cancelFromQueue, takeReady, summarize, formatQueue } from './garbageQueue.js';
import {
  resetPowerups, pausePowerups, schedulePowerup, recordLock, claimPowerup,
  hasEffect, consumeEffect, forcePowerup,
} from './powerups.js';

// código da sala -> sala (ver createRoom)
const rooms = new Map();
// sessionToken -> jogador (para reconectar após queda ou F5)
const sessions = new Map();
let nextPlayerId = 1;

// Estados em que um jogador que caiu pode voltar com o token.
const RESUMABLE_STATES = [ROOM_STATES.COUNTDOWN, ROOM_STATES.PLAYING, ROOM_STATES.PAUSED];

function createPlayer(socket) {
  return {
    id: `P${nextPlayerId++}`,
    socket,
    connected: true,
    sessionToken: null,
    nickname: '',
    room: null,
    ready: false,
    lastSeq: 0,       // último seq aceito deste jogador
    garbageQueue: [], // lixo pendente que este jogador vai receber
    effect: null,     // efeito de power-up guardado (escudo | dobro)
    lastLock: null,   // último piece_locked aceito: { linesCleared, at }
    checkpoint: null, // { board, hold, piecesLocked, score, lines } do último piece_locked
    clock: null,      // { rtt, offset } informado pelo cliente (só para o monitor)
  };
}

// Chamado a cada nova conexão de socket.
// `conn.player` é o jogador associado a esta conexão. Começa como um jogador
// novo; um `rejoin` aceito troca para o jogador antigo da sessão, que mantém
// sala, seq, fila de lixo, efeito e checkpoint.
export function handleConnection(socket) {
  const conn = { player: createPlayer(socket) };
  logEvent('CONEXAO', conn.player, 'connect', null, `socket=${socket.id}`);

  onClientEvent(conn, C.TIME_PING, (player, data) => {
    send(player, S.TIME_PONG, { clientTime: data.clientTime, serverTime: Date.now() });
  });
  onClientEvent(conn, C.REJOIN, (player, data) => rejoin(conn, data));
  onClientEvent(conn, C.CREATE_ROOM, (player, data) => createRoom(player, data.nickname));
  onClientEvent(conn, C.JOIN_ROOM, (player, data) => joinRoom(player, data.nickname, data.code));
  onClientEvent(conn, C.PLAYER_READY, (player) => setReady(player));
  onClientEvent(conn, C.PIECE_LOCKED, (player, data) => pieceLocked(player, data));
  onClientEvent(conn, C.GAME_OVER, (player) => gameOver(player));
  onClientEvent(conn, C.PLAY_AGAIN, (player) => playAgain(player));
  onClientEvent(conn, C.POWERUP_CLAIM, (player, data) => powerupClaim(player, data));
  onClientEvent(conn, C.CLOCK_REPORT, (player, data) => clockReport(player, data));

  // `reason` vem do Socket.IO: "ping timeout" (heartbeat), "transport close",
  // "client namespace disconnect" (cliente fechou), "server namespace disconnect"...
  socket.on('disconnect', (reason) => handleDisconnect(conn.player, socket, reason));
}

// ---------- Recebimento e número de sequência ----------

// Registra um handler que só é chamado se o seq for maior que o último aceito.
// O servidor processa as mensagens na ordem em que chegam; mensagem com seq
// repetido ou menor que o último é descartada (e fica registrada no log).
// Depois de um rejoin, o jogador antigo mantém seu lastSeq: mensagens velhas
// que cheguem depois da reconexão continuam sendo filtradas.
function onClientEvent(conn, eventName, handler) {
  conn.player.socket.on(eventName, (data = {}) => {
    const player = conn.player;
    if (!Number.isInteger(data.seq) || data.seq <= player.lastSeq) {
      logEvent('DESCARTADO', player, eventName, data,
        `seq repetido ou fora de ordem; último=${player.lastSeq}`);
      return;
    }
    player.lastSeq = data.seq;
    logEvent('RECEBIDO', player, eventName, data);
    handler(player, data);
  });
}

// ---------- Estado da sala ----------

function setState(room, newState) {
  if (room.state === newState) return;
  logEvent('SALA', { id: '--', room }, `estado: ${room.state} -> ${newState}`);
  room.state = newState;
}

// Estado "de lobby" depende só de quantos jogadores há na sala.
// Também zera os "Pronto", pois a composição da sala mudou.
function resetLobby(room) {
  for (const p of room.players) p.ready = false;
  resetPowerups(room);
  setState(room, room.players.length === MAX_PLAYERS ? ROOM_STATES.READY : ROOM_STATES.WAITING);
}

function sendRoomUpdate(room) {
  broadcast(room, S.ROOM_UPDATE, {
    code: room.code,
    state: room.state,
    players: room.players.map((p) => ({
      id: p.id, nickname: p.nickname, ready: p.ready, connected: p.connected,
    })),
  });
}

// Código de 5 caracteres sem letras/números ambíguos (0/O, 1/I).
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function cleanNickname(nickname) {
  const name = String(nickname ?? '').trim().slice(0, 16);
  return name || 'Jogador';
}

// ---------- Entrar e sair da sala ----------

function createRoom(player, nickname) {
  if (player.room) return reject(player, C.CREATE_ROOM, 'jogador já está numa sala');

  const room = {
    code: generateRoomCode(),
    state: ROOM_STATES.WAITING,
    players: [],
    seed: null,
    countdownTimer: null,
    playAt: null,           // instante (relógio do servidor) em que a contagem termina
    powerup: null,          // power-up ativo (ver powerups.js)
    powerupTimer: null,
    pastPowerupIds: new Set(),
    pausedAt: null,         // início da pausa atual
    reconnectDeadline: null,
    reconnectTimer: null,
  };
  rooms.set(room.code, room);
  logEvent('SALA', { id: player.id, room }, 'sala criada');
  addPlayer(room, player, nickname);
}

function joinRoom(player, nickname, code) {
  if (player.room) return reject(player, C.JOIN_ROOM, 'jogador já está numa sala');

  const room = rooms.get(String(code ?? '').trim().toUpperCase());
  let error = null;
  if (!room) error = 'Sala não encontrada.';
  else if (room.players.length >= MAX_PLAYERS) error = 'Sala cheia.';
  else if (room.state !== ROOM_STATES.WAITING) error = 'A sala não está aceitando jogadores agora.';

  if (error) return send(player, S.ROOM_ERROR, { message: error });
  addPlayer(room, player, nickname);
}

function addPlayer(room, player, nickname) {
  player.nickname = cleanNickname(nickname);
  player.room = room;
  player.sessionToken = randomUUID(); // identidade da sessão, sobrevive a quedas e F5
  sessions.set(player.sessionToken, player);
  room.players.push(player);
  send(player, S.ROOM_JOINED, { code: room.code, playerId: player.id, sessionToken: player.sessionToken });
  resetLobby(room);
  sendRoomUpdate(room);
}

// Remove de vez o jogador da sala (lobby, fim de partida ou W.O.).
function removeFromRoom(player) {
  const room = player.room;
  if (!room) return;
  room.players = room.players.filter((p) => p !== player);
  player.room = null;
  sessions.delete(player.sessionToken);

  if (room.players.length === 0) return deleteRoom(room, 'vazia');
  if (room.state !== ROOM_STATES.ENDED) resetLobby(room);
  sendRoomUpdate(room);
}

function deleteRoom(room, why) {
  clearTimeout(room.countdownTimer);
  clearTimeout(room.reconnectTimer);
  resetPowerups(room);
  for (const p of room.players) {
    sessions.delete(p.sessionToken);
    p.room = null;
  }
  rooms.delete(room.code);
  logEvent('SALA', { id: '--', room }, `sala removida (${why})`);
}

// ---------- Início da partida ----------

function setReady(player) {
  const room = player.room;
  if (!room || room.state !== ROOM_STATES.READY) {
    return reject(player, C.PLAYER_READY, 'sala não está no estado "pronta"');
  }
  player.ready = true;
  sendRoomUpdate(room);

  if (room.players.every((p) => p.ready)) startMatch(room);
}

// Os dois estão prontos: o servidor sorteia a semente e marca o instante
// de início NO RELÓGIO DO SERVIDOR. Cada cliente converte para o seu relógio
// usando o offset calculado pelo algoritmo de Cristian.
function startMatch(room) {
  room.seed = randomSeed();
  for (const p of room.players) {
    p.garbageQueue = [];
    p.checkpoint = null;
  }
  resetPowerups(room);
  const startAt = Date.now() + COUNTDOWN_MS;
  startCountdown(room, startAt);
  broadcast(room, S.GAME_START, { seed: room.seed, startAt });
  sendRoomUpdate(room);
}

// Contagem até `playAt` (início ou retomada). Ao terminar, a sala vai para
// "jogando" e o timer de surgimento de power-up começa do zero.
function startCountdown(room, playAt) {
  setState(room, ROOM_STATES.COUNTDOWN);
  room.playAt = playAt;
  room.countdownTimer = setTimeout(() => {
    room.countdownTimer = null;
    setState(room, ROOM_STATES.PLAYING);
    sendRoomUpdate(room);
    schedulePowerup(room);
  }, playAt - Date.now());
}

// ---------- Durante a partida ----------

// "pausada" também aceita piece_locked/game_over: são mensagens que o jogador
// que ficou já tinha enviado antes de saber da pausa.
function inMatch(room) {
  return room && (room.state === ROOM_STATES.PLAYING || room.state === ROOM_STATES.PAUSED);
}

function pieceLocked(player, data) {
  const room = player.room;
  if (!inMatch(room)) return reject(player, C.PIECE_LOCKED, 'sala não está em jogo');

  const { board, linesCleared, hold, piecesLocked, score, lines } = data;
  if (!Number.isInteger(linesCleared) || linesCleared < 0 || linesCleared > MAX_LINES_CLEARED) {
    return reject(player, C.PIECE_LOCKED, `linesCleared inválido: ${linesCleared}`);
  }
  if (!isValidBoard(board)) return reject(player, C.PIECE_LOCKED, 'tabuleiro inválido');
  if (hasFullRow(board)) return reject(player, C.PIECE_LOCKED, 'tabuleiro com linha completa');
  if (!isValidCheckpoint(hold, piecesLocked, score, lines)) {
    return reject(player, C.PIECE_LOCKED, 'checkpoint inválido');
  }

  // Checkpoint: o suficiente para reconstruir o jogo se o jogador recarregar a página.
  player.checkpoint = { board, hold, piecesLocked, score, lines };
  recordLock(player, linesCleared); // usado para validar um powerup_claim logo em seguida

  const opponent = room.players.find((p) => p !== player);
  if (!opponent) return;
  send(opponent, S.OPPONENT_BOARD, { board });

  if (linesCleared > 0) handleAttack(player, opponent, linesCleared);
  else applyReadyGarbage(player);
}

// Ataque: o SERVIDOR calcula o valor a partir das linhas limpas.
//   1. cancela primeiro a fila pendente do próprio atacante
//   2. o que sobrar vai para a fila do adversário (pronto em GARBAGE_DELAY_MS)
// Como o Node processa um evento por vez, dois ataques "simultâneos" são
// sempre resolvidos na ordem em que chegaram ao servidor.
//
// Efeitos de power-up (guardados no servidor) entram aqui:
//   - "dobro" do atacante dobra o ataque ANTES do cancelamento
//   - "escudo" do adversário descarta o que iria para a fila dele
function handleAttack(attacker, opponent, linesCleared) {
  const now = Date.now();
  const notes = [];

  const baseAttack = attackFor(linesCleared);
  const doubled = baseAttack > 0 && hasEffect(attacker, POWERUP_TYPES.DOUBLE);
  const attack = doubled ? baseAttack * 2 : baseAttack;
  if (doubled) notes.push(`dobro ${baseAttack}→${attack}`);

  const cancelled = cancelFromQueue(attacker.garbageQueue, attack);
  let sent = attack - cancelled;

  let blocked = 0;
  if (sent > 0 && hasEffect(opponent, POWERUP_TYPES.SHIELD)) {
    blocked = sent;
    sent = 0;
    notes.push(`escudo de ${opponent.id} bloqueou ${blocked}`);
  }
  if (sent > 0) opponent.garbageQueue.push(createEntry(sent, now));

  logEvent('ATAQUE', attacker, `limpou=${linesCleared} ataque=${attack} cancelou=${cancelled} ` +
    `enviou=${sent}${notes.length ? ` [${notes.join('; ')}]` : ''} | filas: ` +
    `${attacker.id}=${formatQueue(attacker.garbageQueue, now)} ` +
    `${opponent.id}=${formatQueue(opponent.garbageQueue, now)}`);

  send(attacker, S.ATTACK_RESULT, { attack, cancelled, sent, blocked });
  if (cancelled > 0) sendGarbageQueue(attacker, now);
  if (sent > 0) sendGarbageQueue(opponent, now);

  if (doubled) consumeEffect(attacker, `ataque dobrado de ${baseAttack} para ${attack}`);
  if (blocked > 0) consumeEffect(opponent, `bloqueou ${blocked} linha(s) de lixo`);
}

// Travou SEM limpar linhas: o lixo já pronto entra no tabuleiro dele.
function applyReadyGarbage(player) {
  const now = Date.now();
  const entries = takeReady(player.garbageQueue, now);
  if (entries.length === 0) return;

  // O lixo entra também no checkpoint; senão um F5 logo depois "apagaria" o lixo.
  for (const e of entries) {
    player.checkpoint.board = pushGarbage(player.checkpoint.board, e.lines, e.holeCol).board;
  }

  logEvent('LIXO', player, `aplicado=${formatQueue(entries, now)} ` +
    `| fila restante: ${formatQueue(player.garbageQueue, now)}`);
  send(player, S.GARBAGE_APPLY, {
    entries: entries.map((e) => ({ lines: e.lines, holeCol: e.holeCol })),
  });
  sendGarbageQueue(player, now);
}

function sendGarbageQueue(player, now) {
  send(player, S.GARBAGE_QUEUE, summarize(player.garbageQueue, now));
}

function powerupClaim(player, data) {
  const room = player.room;
  if (!room || room.state !== ROOM_STATES.PLAYING) {
    return reject(player, C.POWERUP_CLAIM, 'sala não está em jogo');
  }
  claimPowerup(player, data.powerupId, data.seq);
}

// ---------- Fim da partida ----------

// O servidor decide o resultado: o PRIMEIRO game_over recebido perde.
// Um segundo game_over (do outro jogador) chega com a sala já "encerrada" e é ignorado.
// Também aceito em "contagem": um jogador que perdeu enquanto estava
// desconectado avisa logo após o rejoin, quando a retomada já começou.
function gameOver(player) {
  const room = player.room;
  if (!inMatch(room) && room?.state !== ROOM_STATES.COUNTDOWN) {
    return reject(player, C.GAME_OVER, 'sala não está em jogo');
  }
  const winner = room.players.find((p) => p !== player);
  endMatch(room, winner, `${player.nickname} perdeu`);
}

function endMatch(room, winner, reason) {
  clearTimeout(room.countdownTimer);
  clearTimeout(room.reconnectTimer);
  room.countdownTimer = null;
  room.reconnectTimer = null;
  resetPowerups(room);
  setState(room, ROOM_STATES.ENDED);
  broadcast(room, S.MATCH_END, {
    winner: winner?.id ?? null,
    winnerNickname: winner?.nickname ?? null,
    reason,
  });
  // Quem está desconectado não volta mais para uma partida encerrada.
  for (const p of room.players.filter((pl) => !pl.connected)) removeFromRoom(p);
}

function playAgain(player) {
  const room = player.room;
  if (!room) return reject(player, C.PLAY_AGAIN, 'jogador não está numa sala');
  // O primeiro que clicar devolve a sala ao lobby; o segundo só recebe a atualização.
  if (room.state === ROOM_STATES.ENDED) resetLobby(room);
  sendRoomUpdate(room);
}

// ---------- Queda, pausa e reconexão ----------

function handleDisconnect(player, socket, reason) {
  logEvent('CONEXAO', player, 'disconnect', null, `motivo: ${reason}`);
  // Conexão antiga de um jogador que já voltou por outra conexão: nada a fazer.
  if (player.socket !== socket) {
    logEvent('SESSAO', player, 'queda de conexão antiga ignorada (jogador já reconectou)');
    return;
  }
  player.connected = false;
  const room = player.room;
  if (!room) return;

  if (room.state === ROOM_STATES.PLAYING || room.state === ROOM_STATES.COUNTDOWN) {
    pauseMatch(room, player);
  } else if (room.state === ROOM_STATES.PAUSED) {
    // O outro também caiu: o prazo continua o mesmo. Se ninguém voltar, a sala é descartada.
    logEvent('SALA', player, 'segundo jogador caiu durante a pausa');
    sendRoomUpdate(room);
  } else {
    removeFromRoom(player); // lobby ou partida encerrada: sai da sala como antes
  }
}

// Um jogador caiu no meio da partida: em vez de dar a vitória ao outro na
// hora, o servidor congela a partida e espera até o prazo.
function pauseMatch(room, player) {
  const now = Date.now();
  clearTimeout(room.countdownTimer);
  room.countdownTimer = null;
  pausePowerups(room);

  room.pausedAt = now;
  room.reconnectDeadline = now + config.reconnectTimeoutMs;
  setState(room, ROOM_STATES.PAUSED);
  logEvent('SALA', player, `partida pausada; prazo para voltar: ${config.reconnectTimeoutMs}ms`);

  broadcast(room, S.MATCH_PAUSED, {
    reason: `${player.nickname} desconectou`,
    deadline: room.reconnectDeadline,
  });
  sendRoomUpdate(room);
  room.reconnectTimer = setTimeout(() => reconnectTimeout(room), config.reconnectTimeoutMs);
}

// Prazo esgotado: quem não voltou perde por W.O.; se ninguém voltou, a sala some.
function reconnectTimeout(room) {
  room.reconnectTimer = null;
  const connected = room.players.filter((p) => p.connected);
  if (connected.length === 0) {
    logEvent('SALA', { id: '--', room }, 'prazo esgotado e ninguém voltou');
    deleteRoom(room, 'os dois jogadores caíram');
    return;
  }
  logEvent('SALA', { id: '--', room }, 'prazo de reconexão esgotado: vitória por W.O.');
  endMatch(room, connected[0], 'wo');
}

// Todos de volta: nova contagem 3-2-1 até `resumeAt`.
function resumeMatch(room) {
  clearTimeout(room.reconnectTimer);
  room.reconnectTimer = null;
  const now = Date.now();
  const resumeAt = now + COUNTDOWN_MS;

  // O jogo ficou congelado de pausedAt até resumeAt (pausa + contagem).
  // O lixo "a caminho" não pode ter amadurecido nesse tempo: adia o readyAt.
  const frozenMs = resumeAt - room.pausedAt;
  for (const p of room.players) {
    for (const entry of p.garbageQueue) entry.readyAt += frozenMs;
  }
  logEvent('SALA', { id: '--', room }, `retomando em ${COUNTDOWN_MS}ms; readyAt do lixo adiado em ${frozenMs}ms`);

  startCountdown(room, resumeAt);
  broadcast(room, S.MATCH_RESUME, { resumeAt });
  for (const p of room.players) sendGarbageQueue(p, now);
  sendRoomUpdate(room);
}

// rejoin: o cliente apresenta o sessionToken recebido no room_joined.
function rejoin(conn, { sessionToken, code }) {
  const newConn = conn.player; // jogador provisório criado para esta conexão
  const player = sessions.get(sessionToken);
  const room = player?.room;

  let reason = null;
  if (newConn.room && newConn !== player) reason = 'esta conexão já está em outra sala';
  else if (!player || !room) reason = 'sessão inválida';
  else if (room.code !== String(code ?? '').trim().toUpperCase()) reason = 'sessão de outra sala';
  else if (!RESUMABLE_STATES.includes(room.state)) reason = 'partida já encerrada';

  if (reason) {
    logEvent('SESSAO', newConn, 'rejoin recusado', null, reason);
    return send(newConn, S.REJOIN_FAILED, { reason });
  }

  // A conexão nova assume o jogador antigo (com seu seq, fila, checkpoint...).
  const oldSocket = player.socket;
  player.socket = newConn.socket;
  player.connected = true;
  conn.player = player;
  logEvent('SESSAO', player, `rejoin aceito: conexão de ${newConn.id} assume ${player.id}`);
  // Se o servidor ainda não tinha percebido a queda, derruba a conexão antiga.
  if (oldSocket !== player.socket && oldSocket.connected) oldSocket.disconnect(true);

  send(player, S.STATE_SYNC, buildStateSync(player));

  if (room.state === ROOM_STATES.PAUSED) {
    if (room.players.every((p) => p.connected)) {
      resumeMatch(room);
    } else {
      // O outro também caiu: este espera com o mesmo prazo.
      send(player, S.MATCH_PAUSED, { reason: 'adversário desconectado', deadline: room.reconnectDeadline });
      sendRoomUpdate(room);
    }
  }
}

// Tudo o que o cliente precisa para continuar a partida.
function buildStateSync(player) {
  const room = player.room;
  const opponent = room.players.find((p) => p !== player);
  return {
    code: room.code,
    playerId: player.id,
    state: room.state,
    seed: room.seed,
    playAt: room.state === ROOM_STATES.COUNTDOWN ? room.playAt : null,
    checkpoint: player.checkpoint,           // null se ainda não travou nenhuma peça
    opponentBoard: opponent?.checkpoint?.board ?? null,
    opponentNickname: opponent?.nickname ?? null,
    garbage: summarize(player.garbageQueue, Date.now()),
    effect: player.effect,
    lastSeq: player.lastSeq,                 // o cliente continua a numeração daqui
  };
}

// ---------- Monitor (fase 6: só leitura + forçar power-up) ----------

// RTT/offset medidos pelo próprio cliente; guardados só para exibir no monitor.
function clockReport(player, { rtt, offset }) {
  if (!Number.isFinite(rtt) || !Number.isFinite(offset)) {
    return reject(player, C.CLOCK_REPORT, 'valores inválidos');
  }
  player.clock = { rtt, offset };
}

// Retrato de todas as salas para o monitor.
export function getRoomsSnapshot() {
  const now = Date.now();
  return [...rooms.values()].map((room) => ({
    code: room.code,
    state: room.state,
    reconnectDeadline: room.state === ROOM_STATES.PAUSED ? room.reconnectDeadline : null,
    powerup: room.powerup && {
      id: room.powerup.id,
      type: room.powerup.type,
      expiresAt: room.powerup.expiresAt,
      grantedTo: room.powerup.grantedTo?.nickname ?? null,
    },
    players: room.players.map((p) => {
      const garbage = summarize(p.garbageQueue, now);
      return {
        id: p.id,
        nickname: p.nickname,
        connected: p.connected,
        rtt: p.clock?.rtt ?? null,
        offset: p.clock?.offset ?? null,
        garbagePending: garbage.pending,
        garbageReady: garbage.ready,
        effect: p.effect,
        lastSeq: p.lastSeq,
      };
    }),
  }));
}

// Chamado pelo monitor autenticado. Devolve null se deu certo, ou o motivo.
export function forcePowerupInRoom(code) {
  const room = rooms.get(String(code ?? '').toUpperCase());
  if (!room) return 'sala não encontrada';
  return forcePowerup(room);
}

// ---------- Validação ----------

// Validação mínima: matriz ROWS x COLS (não confiamos cegamente no cliente).
function isValidBoard(board) {
  return Array.isArray(board) && board.length === ROWS &&
    board.every((row) => Array.isArray(row) && row.length === COLS);
}

// Depois de travar, a engine já removeu as linhas completas; se ainda houver
// alguma, a mensagem não é coerente.
function hasFullRow(board) {
  return board.some((row) => row.every((cell) => cell !== null));
}

function isValidCheckpoint(hold, piecesLocked, score, lines) {
  const count = (n) => Number.isInteger(n) && n >= 0;
  return (hold === null || PIECE_TYPES.includes(hold)) && count(piecesLocked) && count(score) && count(lines);
}
