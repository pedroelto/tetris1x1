// Testes de protocolo com clientes simulados: node tests/protocol.test.js
// Sobe o próprio servidor numa porta separada (3999), roda os cenários e
// mostra no fim o trecho do log do servidor com ataques e aplicações de lixo.

import { CLIENT_EVENTS as C, SERVER_EVENTS as S, COUNTDOWN_MS } from '../shared/protocol.js';
import { createBoard } from '../shared/engine.js';
import { GARBAGE_DELAY_MS } from '../shared/garbage.js';
import { check, section, finish, sleep, createClient, startServer } from './helpers.js';

const PORT = 3999;
const URL = `http://localhost:${PORT}`;
const board = createBoard(); // tabuleiro vazio e válido
// Checkpoint mínimo que todo piece_locked leva desde a fase 5.
const CP = { hold: null, piecesLocked: 0, score: 0, lines: 0 };

// Power-ups com tempos curtos para o teste rodar rápido.
const server = await startServer(PORT, {
  POWERUP_SPAWN_MIN_MS: '200',
  POWERUP_SPAWN_MAX_MS: '300',
  POWERUP_DURATION_MS: '500',
});

let exitCode = 1;
try {
  await run();
  exitCode = finish();
} catch (err) {
  console.error('\nErro durante os testes:', err.message);
} finally {
  section('Trecho do log do servidor (ataques, lixo e power-ups)');
  for (const line of server.log.filter((l) => / (ATAQUE|LIXO|POWERUP) /.test(l))) console.log('  ' + line);
  server.stop();
  process.exit(exitCode);
}

// ---------- Power-ups ----------

function lock(client, linesCleared) {
  client.send(C.PIECE_LOCKED, { ...CP, board, linesCleared });
}

function claim(client, powerupId) {
  client.send(C.POWERUP_CLAIM, { powerupId });
}

// Espera um power-up surgir DEPOIS de agora (ignora os anteriores).
async function freshSpawn(A, B, type = null) {
  for (let i = 0; i < 40; i++) {
    A.clear();
    B.clear();
    const pu = await A.next(S.POWERUP_SPAWN, 3000);
    // Descarta o que chegou antes do surgimento (ex.: expiração do power-up anterior).
    A.clear();
    B.clear();
    if (!type || pu.type === type) return pu;
  }
  throw new Error(`nenhum power-up do tipo ${type} surgiu`);
}

// Espera o lixo pendente ficar pronto e aplica, zerando as duas filas.
async function drainQueues(A, B) {
  await sleep(GARBAGE_DELAY_MS + 50);
  lock(A, 0);
  lock(B, 0);
  await sleep(100);
}

// Disputa: `first` pede, `gapMs` depois `second` pede.
async function race(first, second, gapMs) {
  const pu = await freshSpawn(first, second);
  lock(first, 2);
  claim(first, pu.id);
  if (gapMs) await sleep(gapMs);
  lock(second, 2);
  claim(second, pu.id);
  await sleep(150);
  return pu;
}

async function newMatch(A, B) {
  A.send(C.GAME_OVER);
  await A.next(S.MATCH_END);
  A.send(C.PLAY_AGAIN);
  B.send(C.PLAY_AGAIN);
  await sleep(100);
  A.send(C.PLAYER_READY);
  B.send(C.PLAYER_READY);
  await A.next(S.GAME_START);
  await sleep(COUNTDOWN_MS + 150);
  A.clear();
  B.clear();
}

async function powerupScenarios(A, B) {
  const TAKEN = 'o adversário pegou primeiro';

  section('7. Dois pedidos válidos quase simultâneos: exatamente um ganha (A chega antes)');
  let pu = await race(A, B, 20);
  check('A recebe powerup_granted', A.count(S.POWERUP_GRANTED) === 1 && A.count(S.POWERUP_DENIED) === 0);
  check(`B é negado com "${TAKEN}"`, B.count(S.POWERUP_GRANTED) === 0 && (await B.next(S.POWERUP_DENIED)).reason === TAKEN);
  check('B recebe powerup_taken com o apelido de A', (await B.next(S.POWERUP_TAKEN)).byNickname === 'Ana');

  section('8. Mesma disputa na ordem inversa (B chega antes)');
  pu = await race(B, A, 20);
  check('B recebe powerup_granted', B.count(S.POWERUP_GRANTED) === 1 && B.count(S.POWERUP_DENIED) === 0);
  check(`A é negado com "${TAKEN}"`, A.count(S.POWERUP_GRANTED) === 0 && (await A.next(S.POWERUP_DENIED)).reason === TAKEN);

  section('9. Pedidos enviados no mesmo instante: exatamente um concedido');
  pu = await race(A, B, 0);
  const grants = A.count(S.POWERUP_GRANTED) + B.count(S.POWERUP_GRANTED);
  const denied = [...A.received, ...B.received].filter((m) => m.event === S.POWERUP_DENIED && !m.used);
  console.log(`         vencedor: ${A.count(S.POWERUP_GRANTED) ? 'A' : 'B'}`);
  check('um concedido e um negado', grants === 1 && denied.length === 1 && denied[0].data.reason === TAKEN);

  section('10. Pedido sem limpar 2+ linhas é negado como inválido');
  pu = await freshSpawn(A, B);
  claim(A, pu.id); // o último lock de A é anterior ao surgimento
  check('sem travamento depois do surgimento => inválido', (await A.next(S.POWERUP_DENIED)).reason === 'pedido inválido');
  lock(A, 1);
  claim(A, pu.id);
  check('limpou só 1 linha => inválido', (await A.next(S.POWERUP_DENIED)).reason === 'pedido inválido');

  section('11. Power-up expirado ou id antigo/inexistente é negado');
  pu = await freshSpawn(A, B);
  check('powerup_expired chega se ninguém pega', (await A.next(S.POWERUP_EXPIRED, 2000)).id === pu.id);
  lock(A, 2);
  claim(A, pu.id);
  check('pedido do power-up expirado => "expirado"', (await A.next(S.POWERUP_DENIED)).reason === 'expirado');
  claim(A, 'PU999999');
  check('id que nunca existiu => "inexistente"', (await A.next(S.POWERUP_DENIED)).reason === 'inexistente');

  section('12. Estado de power-up zerado após "jogar de novo"');
  // B pega um efeito e a partida termina sem ele ser usado.
  pu = await freshSpawn(A, B);
  lock(B, 2);
  claim(B, pu.id);
  const kept = await B.next(S.POWERUP_GRANTED);
  console.log(`         B termina a partida com o efeito "${kept.type}" sem usar`);
  await newMatch(A, B);
  lock(B, 2);
  claim(B, pu.id);
  check('power-up da partida anterior não existe mais', (await B.next(S.POWERUP_DENIED)).reason === 'inexistente');
  await drainQueues(A, B);
  A.clear();
  B.clear();
  lock(A, 3); // ataque 2: o escudo antigo de B não pode bloquear
  let r = await A.next(S.ATTACK_RESULT);
  check('ataque de A não é bloqueado', r.attack === 2 && r.blocked === 0 && r.sent === 2);
  await drainQueues(A, B);
  lock(B, 3); // ataque 2: o dobro antigo de B não pode dobrar
  r = await B.next(S.ATTACK_RESULT);
  check('ataque de B não é dobrado', r.attack === 2);
  check('nenhum efeito consumido', A.count(S.POWERUP_CONSUMED) + B.count(S.POWERUP_CONSUMED) === 0);
  await drainQueues(A, B);

  section('13. Escudo bloqueia o próximo ataque recebido e é consumido');
  pu = await freshSpawn(A, B, 'escudo');
  lock(B, 2);
  claim(B, pu.id);
  check('B ganha o escudo', (await B.next(S.POWERUP_GRANTED)).type === 'escudo');
  await drainQueues(A, B);
  B.clear();
  lock(A, 4);
  r = await A.next(S.ATTACK_RESULT);
  check('tetris de A: 4 bloqueados, 0 enviados', r.attack === 4 && r.blocked === 4 && r.sent === 0);
  check('B é avisado que o escudo foi consumido', (await B.next(S.POWERUP_CONSUMED)).type === 'escudo');
  check('fila de B não mudou', B.count(S.GARBAGE_QUEUE) === 0);
  lock(A, 4);
  r = await A.next(S.ATTACK_RESULT);
  check('próximo tetris de A passa (escudo já gasto)', r.sent === 4 && r.blocked === 0);
  check('fila de B recebe 4', (await B.next(S.GARBAGE_QUEUE)).pending === 4);

  section('14. Dobro dobra o próximo ataque e é consumido');
  pu = await freshSpawn(A, B, 'dobro');
  lock(B, 2);
  claim(B, pu.id);
  check('B ganha o dobro', (await B.next(S.POWERUP_GRANTED)).type === 'dobro');
  await drainQueues(A, B);
  A.clear();
  B.clear();
  lock(B, 3); // ataque 2 => 4
  r = await B.next(S.ATTACK_RESULT);
  check('triple de B: ataque 2 dobrado para 4', r.attack === 4 && r.sent === 4);
  check('B é avisado que o dobro foi consumido', (await B.next(S.POWERUP_CONSUMED)).type === 'dobro');
  check('fila de A recebe 4', (await A.next(S.GARBAGE_QUEUE)).pending === 4);
  lock(B, 3);
  r = await B.next(S.ATTACK_RESULT);
  check('próximo triple de B volta a valer 2', r.attack === 2);
}

// ---------- Cenários ----------

async function run() {
  const A = createClient(URL, 'A');
  const B = createClient(URL, 'B');
  const C3 = createClient(URL, 'C');

  section('Salas e sequência (fase 2)');
  A.send(C.TIME_PING, { clientTime: Date.now() });
  check('time_pong traz serverTime', typeof (await A.next(S.TIME_PONG)).serverTime === 'number');

  A.send(C.CREATE_ROOM, { nickname: 'Ana' });
  const { code } = await A.next(S.ROOM_JOINED);
  check('código com 5 caracteres', /^[A-Z2-9]{5}$/.test(code));

  B.send(C.JOIN_ROOM, { nickname: 'Beto', code: 'ZZZZZ' });
  check('código inexistente => erro', (await B.next(S.ROOM_ERROR)).message.includes('não encontrada'));
  B.send(C.JOIN_ROOM, { nickname: 'Beto', code: code.toLowerCase() });
  await B.next(S.ROOM_JOINED);
  C3.send(C.JOIN_ROOM, { nickname: 'Caio', code });
  check('terceiro jogador => sala cheia', (await C3.next(S.ROOM_ERROR)).message === 'Sala cheia.');

  A.send(C.PLAYER_READY);
  B.send(C.PLAYER_READY);
  const startA = await A.next(S.GAME_START);
  const startB = await B.next(S.GAME_START);
  check('mesma semente para os dois', startA.seed === startB.seed);
  await sleep(COUNTDOWN_MS + 150);
  A.clear();
  B.clear();

  A.send(C.PIECE_LOCKED, { ...CP, board, linesCleared: 0 });
  check('B recebe o tabuleiro de A', (await B.next(S.OPPONENT_BOARD)).board.length === 20);
  A.sendRaw(C.PIECE_LOCKED, { ...CP, seq: 1, board, linesCleared: 0 });
  await sleep(100);
  check('seq antigo é descartado', B.count(S.OPPONENT_BOARD) === 0);

  section('1. Ataque sem fila pendente vai inteiro para o adversário');
  A.send(C.PIECE_LOCKED, { ...CP, board, linesCleared: 3 }); // triple => 2
  const r1 = await A.next(S.ATTACK_RESULT);
  check('A: ataque=2, cancelado=0, enviado=2', r1.attack === 2 && r1.cancelled === 0 && r1.sent === 2);
  const qB1 = await B.next(S.GARBAGE_QUEUE);
  check('fila de B: 2 pendentes, 0 prontas', qB1.pending === 2 && qB1.ready === 0);

  section('2. Ataque com fila pendente cancela primeiro e envia só o excedente');
  B.send(C.PIECE_LOCKED, { ...CP, board, linesCleared: 4 }); // tetris => 4
  const r2 = await B.next(S.ATTACK_RESULT);
  check('B: ataque=4, cancelado=2, enviado=2', r2.attack === 4 && r2.cancelled === 2 && r2.sent === 2);
  check('fila de B zerada', (await B.next(S.GARBAGE_QUEUE)).pending === 0);
  check('fila de A recebe 2', (await A.next(S.GARBAGE_QUEUE)).pending === 2);

  section(`3. Lixo ainda não pronto (< ${GARBAGE_DELAY_MS} ms) não é aplicado`);
  A.send(C.PIECE_LOCKED, { ...CP, board, linesCleared: 0 });
  await sleep(150);
  check('nenhum garbage_apply para A', A.count(S.GARBAGE_APPLY) === 0);

  section('4. Lixo pronto é aplicado em travamento sem limpeza e sai da fila');
  await sleep(GARBAGE_DELAY_MS);
  A.send(C.PIECE_LOCKED, { ...CP, board, linesCleared: 0 });
  const apply = await A.next(S.GARBAGE_APPLY);
  const entry = apply.entries[0];
  check('aplica 1 entrada com 2 linhas', apply.entries.length === 1 && entry.lines === 2);
  check('buraco numa coluna válida', Number.isInteger(entry.holeCol) && entry.holeCol >= 0 && entry.holeCol < 10);
  check('fila de A fica vazia', (await A.next(S.GARBAGE_QUEUE)).pending === 0);

  section('5. Dois ataques quase simultâneos: resolvidos pela ordem de chegada');
  A.clear();
  B.clear();
  A.send(C.PIECE_LOCKED, { ...CP, board, linesCleared: 4 }); // A ataca 4
  B.send(C.PIECE_LOCKED, { ...CP, board, linesCleared: 3 }); // B ataca 2
  const ra = await A.next(S.ATTACK_RESULT);
  const rb = await B.next(S.ATTACK_RESULT);
  const aFirst = ra.cancelled === 0 && ra.sent === 4 && rb.cancelled === 2 && rb.sent === 0;
  const bFirst = rb.cancelled === 0 && rb.sent === 2 && ra.cancelled === 2 && ra.sent === 2;
  console.log(`         ordem de chegada no servidor: ${aFirst ? 'A depois B' : bFirst ? 'B depois A' : '???'}`);
  check('resultados coerentes com uma ordem de chegada', aFirst || bFirst);
  await sleep(100);
  check('fila final de A = 0', (A.last(S.GARBAGE_QUEUE)?.pending ?? 0) === 0);
  check('fila final de B = 2', B.last(S.GARBAGE_QUEUE)?.pending === 2);

  section('6. piece_locked inválido é descartado');
  B.clear();
  const fullRow = createBoard();
  fullRow[19].fill('G');
  for (const bad of [5, -1, 1.5, '2', undefined]) {
    A.send(C.PIECE_LOCKED, { ...CP, board, linesCleared: bad });
  }
  A.send(C.PIECE_LOCKED, { ...CP, board: fullRow, linesCleared: 0 });
  await sleep(150);
  check('nenhum tabuleiro repassado para B', B.count(S.OPPONENT_BOARD) === 0);
  check('nenhum ataque processado', A.count(S.ATTACK_RESULT) === 0 && B.count(S.GARBAGE_QUEUE) === 0);

  await powerupScenarios(A, B);

  A.close();
  B.close();
  C3.close();
}
