// Testes de tolerância a falhas (fase 5): node tests/reconnect.test.js
// Sobe o servidor na porta 3998 com prazos curtos e simula quedas, F5 e W.O.

import {
  CLIENT_EVENTS as C, SERVER_EVENTS as S, COUNTDOWN_MS, ROOM_STATES,
} from '../shared/protocol.js';
import { createBoard, TetrisGame } from '../shared/engine.js';
import { GARBAGE_DELAY_MS } from '../shared/garbage.js';
import { check, section, finish, sleep, createClient, startServer } from './helpers.js';

const PORT = 3998;
const URL = `http://localhost:${PORT}`;
const RECONNECT_TIMEOUT_MS = 1500;
const POWERUP_SPAWN_MIN_MS = 500;
const POWERUP_DURATION_MS = 3000;
const emptyBoard = createBoard(); // declarado antes de run() (await no topo do módulo)

const server = await startServer(PORT, {
  RECONNECT_TIMEOUT_MS: String(RECONNECT_TIMEOUT_MS),
  POWERUP_SPAWN_MIN_MS: String(POWERUP_SPAWN_MIN_MS),
  POWERUP_SPAWN_MAX_MS: '600',
  POWERUP_DURATION_MS: String(POWERUP_DURATION_MS),
});

let exitCode = 1;
try {
  await run();
  exitCode = finish();
} catch (err) {
  console.error('\nErro durante os testes:', err.message);
} finally {
  section('Trecho do log do servidor (conexões, sessões e salas)');
  for (const line of server.log.filter((l) => / (CONEXAO|SESSAO|SALA) /.test(l)).slice(-25)) {
    console.log('  ' + line);
  }
  server.stop();
  process.exit(exitCode);
}

// ---------- Utilitários ----------

function lock(client, linesCleared, extra = {}) {
  client.send(C.PIECE_LOCKED, {
    board: emptyBoard, linesCleared, hold: null, piecesLocked: 0, score: 0, lines: 0, ...extra,
  });
}

// Cria sala com dois jogadores, os dois ficam prontos e a partida começa.
async function setupMatch() {
  const A = createClient(URL, 'A');
  const B = createClient(URL, 'B');
  await A.connected();
  await B.connected();
  A.send(C.CREATE_ROOM, { nickname: 'Ana' });
  const joinedA = await A.next(S.ROOM_JOINED);
  B.send(C.JOIN_ROOM, { nickname: 'Beto', code: joinedA.code });
  const joinedB = await B.next(S.ROOM_JOINED);
  A.send(C.PLAYER_READY);
  B.send(C.PLAYER_READY);
  const start = await A.next(S.GAME_START);
  await B.next(S.GAME_START);
  await sleep(COUNTDOWN_MS + 150);
  A.clear();
  B.clear();
  return {
    A, B,
    code: joinedA.code,
    seed: start.seed,
    idA: joinedA.playerId,
    tokenA: joinedA.sessionToken,
    tokenB: joinedB.sessionToken,
  };
}

// Reconecta o MESMO cliente (só o socket caiu, sem F5) e faz o rejoin.
async function reconnectSameClient(client, token, code) {
  client.socket.connect();
  await client.connected();
  client.send(C.REJOIN, { sessionToken: token, code });
  return client.next(S.STATE_SYNC);
}

async function run() {
  section('1. Queda e reconexão com o mesmo token dentro do prazo');
  let m = await setupMatch();
  m.A.socket.disconnect();
  const paused = await m.B.next(S.MATCH_PAUSED);
  const expectedDeadline = Date.now() + RECONNECT_TIMEOUT_MS;
  check('B recebe match_paused com o motivo', paused.reason.includes('Ana'));
  check('deadline ≈ agora + prazo', Math.abs(paused.deadline - expectedDeadline) < 300);
  let sync = await reconnectSameClient(m.A, m.tokenA, m.code);
  check('state_sync aceito, sala "pausada", mesma semente', sync.state === ROOM_STATES.PAUSED && sync.seed === m.seed);
  const resumeA = await m.A.next(S.MATCH_RESUME);
  const resumeB = await m.B.next(S.MATCH_RESUME);
  check('resumeAt igual para os dois', resumeA.resumeAt === resumeB.resumeAt);
  check('resumeAt ≈ agora + 3 s', Math.abs(resumeA.resumeAt - Date.now() - COUNTDOWN_MS) < 300);
  await sleep(COUNTDOWN_MS + 150);
  lock(m.A, 0);
  check('partida continua: B recebe o tabuleiro de A', (await m.B.next(S.OPPONENT_BOARD)).board.length === 20);
  m.A.close();
  m.B.close();

  section('2. Power-up ativo é cancelado na pausa e o timer reinicia na retomada');
  m = await setupMatch();
  const pu = await m.A.next(S.POWERUP_SPAWN, 3000);
  m.B.socket.disconnect();
  check('A recebe powerup_expired do power-up ativo', (await m.A.next(S.POWERUP_EXPIRED)).id === pu.id);
  await m.A.next(S.MATCH_PAUSED);
  await reconnectSameClient(m.B, m.tokenB, m.code);
  const resume2 = await m.A.next(S.MATCH_RESUME);
  const nextPu = await m.A.next(S.POWERUP_SPAWN, 3000 + COUNTDOWN_MS);
  const spawnedAt = nextPu.expiresAt - POWERUP_DURATION_MS;
  check('próximo power-up só surge depois da retomada + intervalo mínimo',
    spawnedAt >= resume2.resumeAt + POWERUP_SPAWN_MIN_MS - 5);
  m.A.close();
  m.B.close();

  section('3. readyAt da fila de lixo é adiado pela duração da pausa');
  m = await setupMatch();
  lock(m.A, 4); // ataque 4 para B
  const before = (await m.B.next(S.GARBAGE_QUEUE)).entries[0].readyAt;
  m.B.socket.disconnect();
  const paused3 = await m.A.next(S.MATCH_PAUSED);
  await sleep(400);
  sync = await reconnectSameClient(m.B, m.tokenB, m.code);
  check('state_sync traz a fila pendente (4 linhas)', sync.garbage.pending === 4);
  const resume3 = await m.A.next(S.MATCH_RESUME);
  const after = (await m.B.next(S.GARBAGE_QUEUE)).entries[0].readyAt;
  const pausedAt = paused3.deadline - RECONNECT_TIMEOUT_MS;
  console.log(`         readyAt adiado em ${after - before} ms (pausa + contagem)`);
  check('readyAt novo = antigo + (resumeAt - início da pausa)', after === before + (resume3.resumeAt - pausedAt));
  await sleep(COUNTDOWN_MS + 50);
  lock(m.B, 0);
  await sleep(100);
  check('logo após retomar, o lixo ainda não é aplicado', m.B.count(S.GARBAGE_APPLY) === 0);
  await sleep(GARBAGE_DELAY_MS);
  lock(m.B, 0);
  check('depois do tempo restante, o lixo é aplicado', (await m.B.next(S.GARBAGE_APPLY)).entries[0].lines === 4);
  m.A.close();
  m.B.close();

  section('4. F5: novo socket recebe checkpoint, fila, seq; seq antigo é descartado');
  m = await setupMatch();
  const boardA = createBoard();
  boardA[19][0] = 'I';
  const boardB = createBoard();
  boardB[19][9] = 'Z';
  lock(m.B, 4, { board: boardB }); // B ataca 4 em A
  await m.A.next(S.GARBAGE_QUEUE);
  await sleep(GARBAGE_DELAY_MS + 50);
  lock(m.A, 0, { board: boardA, hold: 'T', piecesLocked: 5, score: 300, lines: 2 });
  const applied = (await m.A.next(S.GARBAGE_APPLY)).entries[0];
  lock(m.B, 3, { board: boardB }); // mais 2 pendentes para A (não aplicados)
  await m.A.next(S.GARBAGE_QUEUE);
  const lastSeqA = m.A.seq;
  m.A.close(); // aba fechada / recarregada
  await m.B.next(S.MATCH_PAUSED);

  const A2 = createClient(URL, 'A2'); // página recarregada: seq recomeça do zero
  await A2.connected();
  A2.send(C.REJOIN, { sessionToken: m.tokenA, code: m.code });
  sync = await A2.next(S.STATE_SYNC);
  const cp = sync.checkpoint;
  check('mesmo jogador e mesma semente', sync.playerId === m.idA && sync.seed === m.seed);
  check(`lastSeq = último seq aceito (${lastSeqA})`, sync.lastSeq === lastSeqA);
  check('checkpoint: hold, peças, pontos e linhas', cp.hold === 'T' && cp.piecesLocked === 5 && cp.score === 300 && cp.lines === 2);
  check('checkpoint inclui o lixo aplicado (4 linhas, buraco certo)',
    cp.board.slice(16).every((row) => row[applied.holeCol] === null && row.filter(Boolean).length === 9));
  check('bloco do jogador subiu junto com o lixo', cp.board[15][0] === 'I');
  check('fila pendente (2) vem no state_sync', sync.garbage.pending === 2);
  check('tabuleiro do adversário vem no state_sync', sync.opponentBoard[19][9] === 'Z');
  const restored = TetrisGame.fromCheckpoint(sync.seed, cp);
  check('cliente consegue reconstruir o jogo', !restored.isOver && restored.holdType === 'T');

  A2.continueSeqFrom(sync.lastSeq);
  await A2.next(S.MATCH_RESUME);
  await sleep(COUNTDOWN_MS + 150);
  m.B.clear();
  A2.sendRaw(C.PIECE_LOCKED, { board: emptyBoard, linesCleared: 0, hold: null, piecesLocked: 6, score: 0, lines: 0, seq: lastSeqA });
  await sleep(150);
  check('mensagem com seq antigo após a reconexão é descartada', m.B.count(S.OPPONENT_BOARD) === 0);
  check('descarte registrado no log do servidor',
    server.log.some((l) => l.includes('DESCARTADO') && l.includes(`seq=${lastSeqA} `) && l.includes(m.code)));
  lock(A2, 0, { piecesLocked: 6 });
  check('mensagem nova (lastSeq + 1) é aceita', (await m.B.next(S.OPPONENT_BOARD)).board.length === 20);
  A2.close();
  m.B.close();

  section('5. Queda sem reconexão: W.O. para o outro após o prazo');
  m = await setupMatch();
  m.A.close();
  await m.B.next(S.MATCH_PAUSED);
  const end = await m.B.next(S.MATCH_END, RECONNECT_TIMEOUT_MS + 1500);
  check('match_end com reason "wo" e vitória de B', end.reason === 'wo' && end.winnerNickname === 'Beto');
  const late = createClient(URL, 'atrasado');
  await late.connected();
  late.send(C.REJOIN, { sessionToken: m.tokenA, code: m.code });
  check('quem perdeu por W.O. não volta mais', Boolean((await late.next(S.REJOIN_FAILED)).reason));
  const B2 = createClient(URL, 'B2');
  await B2.connected();
  B2.send(C.REJOIN, { sessionToken: m.tokenB, code: m.code });
  check('token de partida encerrada é rejeitado', (await B2.next(S.REJOIN_FAILED)).reason === 'partida já encerrada');
  late.close();
  B2.close();
  m.B.close();

  section('6. Token inválido e token de outra sala são rejeitados');
  m = await setupMatch();
  const other = await setupMatch();
  const X = createClient(URL, 'X');
  await X.connected();
  X.send(C.REJOIN, { sessionToken: 'token-que-nao-existe', code: m.code });
  check('token inválido => "sessão inválida"', (await X.next(S.REJOIN_FAILED)).reason === 'sessão inválida');
  X.send(C.REJOIN, { sessionToken: m.tokenA, code: other.code });
  check('token de outra sala => "sessão de outra sala"', (await X.next(S.REJOIN_FAILED)).reason === 'sessão de outra sala');
  lock(m.A, 0);
  check('a partida original não foi afetada', (await m.B.next(S.OPPONENT_BOARD)).board.length === 20);
  for (const c of [X, m.A, m.B, other.A, other.B]) c.close();

  section('7. Os dois caem: a sala é descartada quando o prazo vence');
  m = await setupMatch();
  m.A.close();
  await m.B.next(S.MATCH_PAUSED);
  m.B.close();
  await sleep(RECONNECT_TIMEOUT_MS + 300);
  check('log registra a sala removida',
    server.log.some((l) => l.includes(`sala=${m.code}`) && l.includes('sala removida (os dois jogadores caíram)')));
  const Y = createClient(URL, 'Y');
  await Y.connected();
  Y.send(C.REJOIN, { sessionToken: m.tokenA, code: m.code });
  check('token da sala descartada é rejeitado', (await Y.next(S.REJOIN_FAILED)).reason === 'sessão inválida');
  Y.close();
}
