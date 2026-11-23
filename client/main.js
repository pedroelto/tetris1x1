// Ponto de entrada do cliente: telas (menu, sala, jogo), modo treino,
// partida 1v1 em rede e o loop de desenho.

import { TetrisGame, GAME_EVENTS, createBoard } from '/shared/engine.js';
import { randomSeed } from '/shared/random.js';
import {
  CLIENT_EVENTS as C, SERVER_EVENTS as S, ROOM_STATES, CLOCK_REPORT_INTERVAL_MS,
} from '/shared/protocol.js';
import { POWERUP_TYPES, POWERUP_MIN_LINES, DENY_REASONS } from '/shared/powerups.js';
import { drawBoard, drawPreview, drawOpponentBoard, drawGarbageBar } from './render.js';
import { setupInput, updateInput } from './input.js';
import * as net from './net.js';
import { setupDebugPanel } from './debug.js';

const $ = (id) => document.getElementById(id);

const screens = { menu: $('menu-screen'), lobby: $('lobby-screen'), game: $('game-screen') };
const boardCtx = $('board').getContext('2d');
const nextCtx = $('next').getContext('2d');
const holdCtx = $('hold').getContext('2d');
const opponentCtx = $('opponent-board').getContext('2d');
const garbageCtx = $('garbage-bar').getContext('2d');

// ---------- Estado do cliente ----------

let mode = null;          // 'training' | 'match' | null
let game = null;          // TetrisGame local
let active = false;       // o jogador pode jogar agora?
let countdownAt = null;   // início da partida, no relógio do SERVIDOR
let opponentBoard = createBoard();
let garbageEntries = [];  // minha fila de lixo pendente (cópia da que está no servidor)
let myId = null;
let overlayAction = null; // o que o botão do overlay faz
let pauseDeadline = null; // partida pausada: prazo (relógio do servidor) para o adversário voltar
let roomState = null;     // último estado da sala informado pelo servidor (só para o painel F2)

// ---------- Sessão (sobrevive a F5 na mesma aba) ----------

const SESSION_KEY = 'tetris-session';

function saveSession(session) {
  try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch { /* sem storage */ }
}

function loadSession() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch { return null; }
}

function clearSession() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch { /* sem storage */ }
}

// ---------- Telas e overlay ----------

function showScreen(name) {
  for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
}

function showOverlay(title, subtitle = '', buttonText = null, action = null) {
  $('overlay-title').textContent = title;
  $('overlay-subtitle').textContent = subtitle;
  $('play-again').hidden = !buttonText;
  $('play-again').textContent = buttonText ?? '';
  overlayAction = action;
  $('overlay').hidden = false;
}

function hideOverlay() {
  $('overlay').hidden = true;
}

$('play-again').addEventListener('click', () => overlayAction?.());

function goToMenu(error = '') {
  mode = null;
  game = null;
  active = false;
  countdownAt = null;
  pauseDeadline = null;
  roomState = null;
  clearSession();
  $('menu-error').textContent = error;
  showScreen('menu');
}

// ---------- Modo treino (single-player da fase 1) ----------

function startTraining() {
  mode = 'training';
  game = new TetrisGame(randomSeed()); // treino: semente local
  active = true;
  game.on(GAME_EVENTS.GAME_OVER, () => {
    showOverlay('Game Over', 'R para jogar de novo', 'Voltar ao menu', () => goToMenu());
  });
  hideOverlay();
  $('opponent-panel').hidden = true;
  $('powerup-panel').hidden = true;
  $('effect-badge').hidden = true;
  $('garbage-bar').hidden = true;
  $('help-retry').hidden = false;
  showScreen('game');
}

// ---------- Partida 1v1 ----------

// game_start: mesma semente para os dois => mesma sequência de peças.
function startMatch(seed, startAt) {
  console.log(`[partida] semente=${seed}, início (relógio do servidor)=${startAt}`);
  enterMatch(new TetrisGame(seed));
  countdownAt = startAt;   // só libera quando a contagem terminar
  opponentBoard = createBoard();
  garbageEntries = [];
  resetPowerupView();
}

// Prepara a tela e os eventos de uma partida para o jogo `newGame`
// (novo, ou reconstruído a partir de um checkpoint após F5).
function enterMatch(newGame) {
  mode = 'match';
  game = newGame;
  active = false;
  countdownAt = null;
  pauseDeadline = null;

  // Ao travar uma peça, manda o tabuleiro (cópia), quantas linhas limpou e o
  // checkpoint (hold, peças travadas, pontos, linhas) para o servidor guardar.
  // Quanto lixo isso gera é decidido pelo servidor, não pelo cliente.
  game.on(GAME_EVENTS.PIECE_LOCKED, ({ linesCleared }) => {
    net.send(C.PIECE_LOCKED, {
      board: game.board.map((row) => [...row]),
      linesCleared,
      hold: game.holdType,
      piecesLocked: game.piecesLocked,
      score: game.score,
      lines: game.lines,
    });

    // Limpou 2+ linhas com power-up na tela: pede o recurso ao coordenador.
    // Vai logo depois do piece_locked (mesmo socket => o servidor recebe nessa ordem).
    if (linesCleared >= POWERUP_MIN_LINES && activePowerup && !activePowerup.claimed) {
      activePowerup.claimed = true;
      net.send(C.POWERUP_CLAIM, { powerupId: activePowerup.id });
    }
  });
  // Perdi localmente: aviso o servidor, mas quem decide o resultado é ele.
  game.on(GAME_EVENTS.GAME_OVER, () => {
    net.send(C.GAME_OVER);
    active = false;
    showOverlay('Fim de jogo', 'Aguardando resultado do servidor...');
  });

  $('opponent-panel').hidden = false;
  $('powerup-panel').hidden = false;
  $('garbage-bar').hidden = false;
  $('help-retry').hidden = true;
  hideOverlay();
  showScreen('game');
}

net.on(S.MATCH_END, ({ winner, reason }) => {
  active = false;
  countdownAt = null;
  pauseDeadline = null;
  resetPowerupView(); // o servidor zera o power-up no fim da partida
  const title = winner === myId ? 'Vitória!' : 'Derrota';
  const subtitle = reason === 'wo' ? 'Adversário não voltou a tempo (W.O.)' : reason;
  showOverlay(title, subtitle, 'Jogar de novo', () => {
    net.send(C.PLAY_AGAIN);
    mode = null;
    game = null;
    showScreen('lobby');
  });
});

net.on(S.GAME_START, ({ seed, startAt }) => startMatch(seed, startAt));
net.on(S.OPPONENT_BOARD, ({ board }) => { opponentBoard = board; });

// ---------- Pausa, reconexão e retomada ----------

// O adversário caiu: os dois jogos param até ele voltar ou o prazo acabar.
net.on(S.MATCH_PAUSED, ({ deadline }) => {
  active = false;
  countdownAt = null;
  pauseDeadline = deadline; // o overlay com a contagem regressiva é desenhado no frame()
});

// Todos de volta: contagem 3-2-1 até resumeAt (mesmo esquema do game_start).
net.on(S.MATCH_RESUME, ({ resumeAt }) => {
  pauseDeadline = null;
  countdownAt = resumeAt;
});

// rejoin é a PRIMEIRA mensagem de uma conexão com sessão salva; o restante
// (sincronização de relógio) só começa depois da resposta.
let rejoinDone = null;
function rejoin(session) {
  $('clock-info').textContent = 'retomando sessão...';
  return new Promise((resolve) => {
    rejoinDone = resolve;
    net.send(C.REJOIN, session);
  });
}

function finishRejoin() {
  rejoinDone?.();
  rejoinDone = null;
}

net.on(S.REJOIN_FAILED, ({ reason }) => {
  goToMenu(`Não foi possível voltar à partida (${reason}).`);
  finishRejoin();
});

net.on(S.STATE_SYNC, (data) => {
  applyStateSync(data);
  finishRejoin();
});

function applyStateSync(data) {
  myId = data.playerId;
  roomState = data.state;
  net.continueSeqFrom(data.lastSeq); // senão o servidor descartaria tudo como mensagem antiga
  $('lobby-code').textContent = data.code;
  if (data.opponentNickname) $('opponent-name').textContent = data.opponentNickname;

  if (mode === 'match' && game) {
    // Só o socket caiu (sem F5): o jogo local é mais recente que o checkpoint.
    console.log('[sessão] reconectado; mantendo o estado local');
  } else {
    // Página recarregada: reconstrói o jogo a partir do checkpoint do servidor
    // (mesma semente + peças já usadas). A peça que estava caindo é perdida.
    const restored = data.checkpoint
      ? TetrisGame.fromCheckpoint(data.seed, data.checkpoint)
      : new TetrisGame(data.seed);
    console.log('[sessão] jogo reconstruído do checkpoint', data.checkpoint);
    enterMatch(restored);
  }
  // Perdi enquanto estava desconectado (ou o jogo restaurado já nasce sem
  // espaço): o game_over ainda não chegou ao servidor.
  if (game.isOver) {
    net.send(C.GAME_OVER);
    return;
  }

  opponentBoard = data.opponentBoard ?? createBoard();
  garbageEntries = data.garbage.entries;
  activePowerup = null;
  myEffect = data.effect;
  renderPowerup();

  if (data.state === ROOM_STATES.PLAYING) {
    // O servidor nem chegou a perceber a queda: continua jogando.
    active = true;
    hideOverlay();
  } else if (data.state === ROOM_STATES.COUNTDOWN) {
    countdownAt = data.playAt;
  } else {
    // "pausada": logo em seguida chega match_resume (ou match_paused, se o outro também caiu).
    active = false;
    showOverlay('Sincronizado', 'aguardando o servidor...');
  }
}

// ---------- Lixo ----------

net.on(S.GARBAGE_QUEUE, ({ entries }) => { garbageEntries = entries; });

// O servidor mandou aplicar: insere as linhas na hora. Se não couber,
// a engine dispara game over e o fluxo normal de game_over segue.
net.on(S.GARBAGE_APPLY, ({ entries }) => {
  if (mode !== 'match' || !game) return;
  for (const { lines, holeCol } of entries) game.addGarbage(lines, holeCol);
});

// Aviso rápido sobre o tabuleiro. items: [[texto, classe CSS], ...]
let flashTimer = null;
function flash(items, durationMs = 900) {
  if (items.length === 0) return;
  const el = $('attack-info');
  el.replaceChildren(...items.map(([text, cls]) => {
    const div = document.createElement('div');
    div.textContent = text;
    div.className = cls;
    return div;
  }));
  el.classList.add('visible');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => el.classList.remove('visible'), durationMs);
}

// Resultado do meu ataque: "+3 enviado", "2 cancelado", "4 bloqueado".
net.on(S.ATTACK_RESULT, ({ cancelled, sent, blocked }) => {
  const items = [];
  if (sent > 0) items.push([`+${sent} enviado`, 'sent']);
  if (cancelled > 0) items.push([`${cancelled} cancelado`, 'cancelled']);
  if (blocked > 0) items.push([`${blocked} bloqueado pelo escudo`, 'bad']);
  flash(items);
});

// ---------- Power-up (quem decide é sempre o servidor) ----------

const POWERUP_INFO = {
  [POWERUP_TYPES.SHIELD]: { icon: '🛡️', name: 'Escudo' },
  [POWERUP_TYPES.DOUBLE]: { icon: '×2', name: 'Dobro' },
};

let activePowerup = null; // { id, type, expiresAt, claimed }
let myEffect = null;      // efeito que o servidor diz que eu tenho

function renderPowerup() {
  const info = activePowerup && POWERUP_INFO[activePowerup.type];
  $('powerup-box').classList.toggle('active', Boolean(info));
  $('powerup-icon').textContent = info ? info.icon : '–';
  $('powerup-label').textContent = info ? info.name : '';
  $('powerup-timer').textContent = '';

  const effect = myEffect && POWERUP_INFO[myEffect];
  $('effect-badge').hidden = !effect;
  if (effect) {
    $('effect-icon').textContent = effect.icon;
    $('effect-name').textContent = effect.name;
  }
}

function resetPowerupView() {
  activePowerup = null;
  myEffect = null;
  renderPowerup();
}

net.on(S.POWERUP_SPAWN, ({ id, type, expiresAt }) => {
  activePowerup = { id, type, expiresAt, claimed: false };
  renderPowerup();
});

net.on(S.POWERUP_EXPIRED, ({ id }) => {
  if (activePowerup?.id !== id) return;
  activePowerup = null;
  renderPowerup();
});

net.on(S.POWERUP_GRANTED, ({ type }) => {
  activePowerup = null;
  myEffect = type;
  renderPowerup();
  flash([[`Você pegou: ${POWERUP_INFO[type].name}!`, 'good']], 1500);
});

net.on(S.POWERUP_TAKEN, ({ byNickname }) => {
  activePowerup = null;
  renderPowerup();
  flash([[`${byNickname} pegou o power-up`, 'bad']], 1500);
});

net.on(S.POWERUP_DENIED, ({ reason }) => {
  const text = reason === DENY_REASONS.TAKEN ? 'Adversário pegou primeiro' : `Power-up negado: ${reason}`;
  flash([[text, 'bad']], 1500);
});

net.on(S.POWERUP_CONSUMED, ({ type, detail }) => {
  myEffect = null;
  renderPowerup();
  flash([[`${POWERUP_INFO[type].name}: ${detail}`, 'good']], 1500);
});

// ---------- Menu e sala ----------

function nickname() {
  return $('nickname').value;
}

$('create-room').addEventListener('click', () => net.send(C.CREATE_ROOM, { nickname: nickname() }));
$('join-room').addEventListener('click', () => {
  net.send(C.JOIN_ROOM, { nickname: nickname(), code: $('room-code').value });
});
$('training').addEventListener('click', startTraining);
$('ready').addEventListener('click', () => net.send(C.PLAYER_READY));

net.on(S.ROOM_ERROR, ({ message }) => { $('menu-error').textContent = message; });

net.on(S.ROOM_JOINED, ({ code, playerId, sessionToken }) => {
  myId = playerId;
  saveSession({ sessionToken, code });
  $('lobby-code').textContent = code;
  $('menu-error').textContent = '';
  showScreen('lobby');
});

net.on(S.ROOM_UPDATE, ({ state, players }) => {
  roomState = state;
  $('lobby-state').textContent = state;

  const list = $('lobby-players');
  list.replaceChildren(...players.map((p) => {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = p.nickname + (p.id === myId ? ' (você)' : '');
    const status = document.createElement('span');
    status.textContent = p.ready ? 'pronto ✓' : 'aguardando';
    li.append(name, status);
    return li;
  }));

  const me = players.find((p) => p.id === myId);
  $('ready').disabled = state !== ROOM_STATES.READY || me?.ready;
  $('ready').textContent = me?.ready ? 'Pronto ✓' : 'Pronto';

  const opponent = players.find((p) => p.id !== myId);
  $('opponent-name').textContent = opponent ? opponent.nickname : 'Adversário';
});

// ---------- Conexão e relógio ----------

// Vale para a primeira conexão (inclusive após F5) e para cada reconexão automática.
net.onConnect(async () => {
  const session = loadSession();
  if (session) await rejoin(session);
  await resyncClock();
});

// Sincroniza o relógio (Cristian), mostra no canto e informa o servidor
// (o RTT/offset de cada jogador aparece no monitor).
async function resyncClock() {
  $('clock-info').textContent = 'sincronizando relógio...';
  const { rtt, offset } = await net.syncClock();
  $('clock-info').textContent = rtt === null
    ? 'relógio não sincronizado'
    : `RTT ${rtt} ms · offset ${offset >= 0 ? '+' : ''}${offset.toFixed(1)} ms`;
  reportClock();
}

function reportClock() {
  // Durante um rejoin, nada pode sair antes dele (com reordenação ligada, um
  // relatório poderia ultrapassá-lo e o rejoin seria descartado pelo seq).
  if (rejoinDone) return;
  if (net.isConnected() && net.clock.rtt !== null) {
    net.send(C.CLOCK_REPORT, { rtt: net.clock.rtt, offset: net.clock.offset });
  }
}
setInterval(reportClock, CLOCK_REPORT_INTERVAL_MS);

net.onDisconnect(() => {
  $('clock-info').textContent = 'desconectado do servidor';
  if (mode === 'match') {
    // No meio da partida: o Socket.IO tenta reconectar sozinho; ao voltar, onConnect faz o rejoin.
    active = false;
    countdownAt = null;
    pauseDeadline = null;
    if (net.isDropSimulated()) {
      showOverlay('Conexão derrubada (simulação)', 'use "Reconectar" no painel F2');
    } else {
      showOverlay('Reconectando...', 'tentando voltar para a partida');
    }
  } else if (mode !== 'training') {
    goToMenu('Conexão com o servidor perdida.');
  }
});

// ---------- Input e loop principal ----------

setupInput(
  () => (active ? game : null),
  () => { if (mode === 'training') startTraining(); }, // R só reinicia no treino
);

// Versão do build no ar (hash do commit no Render, "dev" local), discreta no menu.
fetch('/version')
  .then((res) => res.json())
  .then(({ version }) => { $('build-version').textContent = `versão ${version}`; })
  .catch(() => {});

setupDebugPanel({
  getRoomState: () => roomState,
  onLatencyChanged: () => { if (net.isConnected()) resyncClock(); },
});

let lastTime = performance.now();
function frame(now) {
  // Limita o dt para a peça não "teleportar" depois de a aba ficar em segundo plano.
  const dt = Math.min(now - lastTime, 100);
  lastTime = now;

  // Pausa: contagem regressiva até o prazo de reconexão do adversário.
  if (pauseDeadline !== null) {
    const secs = Math.max(0, Math.ceil((pauseDeadline - net.serverNow()) / 1000));
    showOverlay('Adversário desconectado', `aguardando (${secs}s)`);
  }

  // Contagem 3-2-1: compara o início (relógio do servidor) com a hora do
  // servidor estimada localmente. Assim as duas abas mudam de número juntas.
  if (countdownAt !== null) {
    const remaining = countdownAt - net.serverNow();
    if (remaining > 0) {
      showOverlay(String(Math.ceil(remaining / 1000)), 'Prepare-se!');
    } else {
      countdownAt = null;
      active = true;
      hideOverlay();
    }
  }

  if (game) {
    if (active) {
      updateInput(dt); // DAS/ARR/SDF das teclas seguradas
      game.update(dt);
    }
    drawBoard(boardCtx, game);
    drawPreview(nextCtx, game.nextType);
    drawPreview(holdCtx, game.holdType, !game.canHold);
    $('score').textContent = game.score;
    $('lines').textContent = game.lines;
    $('level').textContent = game.level;
  }
  if (mode === 'match') {
    drawOpponentBoard(opponentCtx, opponentBoard);
    drawGarbageBar(garbageCtx, garbageEntries, net.serverNow());
    if (activePowerup) {
      // expiresAt está no relógio do servidor: converte com o offset de Cristian.
      const secs = Math.max(0, Math.ceil((activePowerup.expiresAt - net.serverNow()) / 1000));
      $('powerup-timer').textContent = `${secs}s`;
    }
  }

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
