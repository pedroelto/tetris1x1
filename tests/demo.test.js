// Testes das ferramentas de demonstração (fase 6): node tests/demo.test.js
// Monitor com chave, forçar power-up, latência artificial (FIFO e com
// reordenação) e "simular queda". Servidor na porta 3997.

import { io } from 'socket.io-client';
import {
  CLIENT_EVENTS as C, SERVER_EVENTS as S, COUNTDOWN_MS, MONITOR_EVENTS as M, ROOM_STATES,
} from '../shared/protocol.js';
import { createBoard } from '../shared/engine.js';
import { createLatencySimulator } from '../client/latency.js';
import { check, section, finish, sleep, createClient, startServer } from './helpers.js';

const PORT = 3997;
const URL = `http://localhost:${PORT}`;
const KEY = 'chave-de-teste';
const emptyBoard = createBoard(); // declarado antes de run() (await no topo do módulo)

const server = await startServer(PORT, {
  MONITOR_KEY: KEY,
  POWERUP_SPAWN_MIN_MS: '600000', // nunca surge sozinho: só forçado pelo monitor
  POWERUP_SPAWN_MAX_MS: '600001',
  POWERUP_DURATION_MS: '1500',
  RECONNECT_TIMEOUT_MS: '5000',
});

let exitCode = 1;
try {
  await run();
  exitCode = finish();
} catch (err) {
  console.error('\nErro durante os testes:', err.message);
} finally {
  server.stop();
  process.exit(exitCode);
}

// ---------- Utilitários ----------

function lockMsg(linesCleared, board = emptyBoard) {
  return { board, linesCleared, hold: null, piecesLocked: 0, score: 0, lines: 0 };
}

// Cliente de monitor: guarda tudo o que recebe.
async function createMonitor(key) {
  const socket = io(URL, { auth: { role: 'monitor', key }, transports: ['websocket'], forceNew: true });
  const got = { history: null, rooms: null, logs: [], errors: [], results: [] };
  socket.on(M.HISTORY, (h) => { got.history = h; });
  socket.on(M.ROOMS, (r) => { got.rooms = r; });
  socket.on(M.LOG, (e) => got.logs.push(e));
  socket.on(M.ERROR, (e) => got.errors.push(e));
  socket.on(M.FORCE_RESULT, (r) => got.results.push(r));
  await sleep(300);
  return { socket, got };
}

async function waitFor(condition, timeoutMs = 3000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) return false;
    await sleep(10);
  }
  return true;
}

// Envia passando pelo simulador de latência do cliente (o mesmo do navegador).
// O seq é atribuído no envio, antes do atraso — igual ao client/net.js.
function sendWithLatency(client, sim, event, data) {
  const seq = client.seq + 1;
  client.continueSeqFrom(seq);
  sim.schedule('out', () => client.sendRaw(event, { ...data, seq }));
}

async function setupMatch() {
  const A = createClient(URL, 'A');
  const B = createClient(URL, 'B');
  await A.connected();
  await B.connected();
  A.send(C.CREATE_ROOM, { nickname: 'Ana' });
  const joined = await A.next(S.ROOM_JOINED);
  B.send(C.JOIN_ROOM, { nickname: 'Beto', code: joined.code });
  await B.next(S.ROOM_JOINED);
  A.send(C.PLAYER_READY);
  B.send(C.PLAYER_READY);
  await A.next(S.GAME_START);
  await sleep(COUNTDOWN_MS + 150);
  A.clear();
  B.clear();
  return { A, B, code: joined.code, token: joined.sessionToken };
}

async function run() {
  section('1. Monitor rejeita chave errada e aceita a correta');
  let res = await fetch(`${URL}/monitor?key=errada`);
  check('HTTP /monitor com chave errada => 403', res.status === 403);
  res = await fetch(`${URL}/monitor`);
  check('HTTP /monitor sem chave (MONITOR_KEY definida) => 403', res.status === 403);
  res = await fetch(`${URL}/monitor?key=${KEY}`);
  check('HTTP /monitor com a chave certa => 200', res.status === 200 && (await res.text()).includes('Monitor do servidor'));

  const intruder = await createMonitor('errada');
  check('socket com chave errada recebe monitor_error', intruder.got.errors[0]?.reason === 'chave inválida');
  check('... e é desconectado sem receber dados', !intruder.socket.connected && intruder.got.history === null);
  const mon = await createMonitor(KEY);
  check('socket com a chave certa recebe histórico e salas', Array.isArray(mon.got.history) && Array.isArray(mon.got.rooms));

  section('2. Monitor recebe o log em tempo real e o RTT informado pelos clientes');
  const m = await setupMatch();
  check('log ao vivo mostra a sala criada',
    mon.got.logs.some((e) => e.event === C.CREATE_ROOM && e.kind === 'RECEBIDO'));
  check('sessionToken não aparece no log', !mon.got.logs.some((e) => e.detail.includes(m.token)));
  m.A.send(C.CLOCK_REPORT, { rtt: 123, offset: -4.5 });
  const sawRtt = await waitFor(() => mon.got.rooms?.find((r) => r.code === m.code)
    ?.players.find((p) => p.nickname === 'Ana')?.rtt === 123);
  check('retrato das salas mostra o RTT informado (123 ms)', sawRtt);

  section('3. Forçar power-up: só pelo monitor');
  m.A.socket.emit(M.FORCE_POWERUP, { code: m.code }); // jogador tentando
  await sleep(400);
  check('jogador emitindo o evento do monitor não cria power-up', m.A.count(S.POWERUP_SPAWN) === 0);
  mon.socket.emit(M.FORCE_POWERUP, { code: m.code });
  await waitFor(() => mon.got.results.length > 0);
  check('monitor recebe confirmação', mon.got.results.at(-1)?.ok === true);
  const spawned = await m.A.next(S.POWERUP_SPAWN);
  await m.B.next(S.POWERUP_SPAWN);
  check('os dois jogadores recebem powerup_spawn', Boolean(spawned.id));
  mon.socket.emit(M.FORCE_POWERUP, { code: m.code });
  await waitFor(() => mon.got.results.length > 1);
  check('forçar com power-up já ativo é recusado', mon.got.results.at(-1)?.ok === false);
  mon.socket.emit(M.FORCE_POWERUP, { code: 'ZZZZZ' });
  await waitFor(() => mon.got.results.length > 2);
  check('sala inexistente é recusada', mon.got.results.at(-1)?.message === 'sala não encontrada');
  await m.A.next(S.POWERUP_EXPIRED, 3000);

  section('4. Latência SEM reordenação mantém a ordem (FIFO)');
  const sim = createLatencySimulator();
  sim.set({ delayMs: 50, jitterMs: 200, allowReorder: false });
  const seqBefore = m.A.seq;
  for (let i = 0; i < 25; i++) {
    const board = createBoard();
    board[0][0] = `m${i}`; // marcador para conferir a ordem de chegada
    sendWithLatency(m.A, sim, C.PIECE_LOCKED, lockMsg(0, board));
  }
  await waitFor(() => m.B.count(S.OPPONENT_BOARD) === 25, 3000);
  const markers = m.B.received.filter((x) => x.event === S.OPPONENT_BOARD && !x.used).map((x) => x.data.board[0][0]);
  check('as 25 mensagens chegam ao adversário', markers.length === 25);
  check('na mesma ordem em que foram enviadas', markers.every((mk, i) => mk === `m${i}`));
  const discardedFifo = server.log.filter((l) => l.includes('DESCARTADO') && l.includes(m.code) &&
    /seq=(\d+)/.test(l) && Number(l.match(/seq=(\d+)/)[1]) > seqBefore).length;
  check('nenhuma descartada pelo servidor', discardedFifo === 0);
  m.B.clear();

  section('5. Latência COM reordenação: mensagens fora de ordem são descartadas');
  sim.set({ delayMs: 50, jitterMs: 300, allowReorder: true });
  const tagsBefore = mon.got.logs.filter((e) => e.tag === 'seq').length;
  for (let i = 0; i < 25; i++) sendWithLatency(m.A, sim, C.PIECE_LOCKED, lockMsg(0));
  await sleep(800);
  const accepted = m.B.count(S.OPPONENT_BOARD);
  const discarded = mon.got.logs.filter((e) => e.tag === 'seq').length - tagsBefore;
  console.log(`         aceitas: ${accepted}, descartadas por seq: ${discarded}`);
  check('algumas chegaram fora de ordem e foram descartadas', discarded > 0);
  check('aceitas + descartadas = 25 (nenhuma perdida sem registro)', accepted + discarded === 25);
  const discardedInServerLog = server.log.filter((l) => l.includes('DESCARTADO') && l.includes(m.code) &&
    l.includes('fora de ordem') && Number(l.match(/seq=(\d+)/)?.[1]) > seqBefore + 25).length;
  check('monitor recebeu os mesmos descartes que o log do servidor', discardedInServerLog === discarded);
  m.B.clear();

  section('6. Com 500 ms de latência, quem limpa primeiro perde a disputa');
  mon.socket.emit(M.FORCE_POWERUP, { code: m.code });
  const pu = await m.B.next(S.POWERUP_SPAWN);
  const slow = createLatencySimulator();
  slow.set({ delayMs: 500 });
  sendWithLatency(m.A, slow, C.PIECE_LOCKED, lockMsg(2)); // A limpa 2 linhas PRIMEIRO...
  sendWithLatency(m.A, slow, C.POWERUP_CLAIM, { powerupId: pu.id });
  await sleep(100);
  m.B.send(C.PIECE_LOCKED, lockMsg(2)); // ...B limpa 100 ms depois, sem latência
  m.B.send(C.POWERUP_CLAIM, { powerupId: pu.id });
  check('B (sem latência) ganha', Boolean(await m.B.next(S.POWERUP_GRANTED)));
  check('A (com latência) é negado: "o adversário pegou primeiro"',
    (await m.A.next(S.POWERUP_DENIED, 2000)).reason === 'o adversário pegou primeiro');
  check('monitor destaca o pedido negado (tag "disputa")', mon.got.logs.some((e) => e.tag === 'disputa'));

  section('7. "Simular queda" pausa a partida; "Reconectar" retoma');
  // Mesmo código do botão do painel (client/net.js simulateDrop/reconnect).
  m.A.socket.io.reconnection(false);
  m.A.socket.io.engine.close();
  const paused = await m.B.next(S.MATCH_PAUSED);
  check('B recebe match_paused', paused.reason.includes('Ana'));
  check('servidor trata como falha de transporte, não saída voluntária',
    server.log.some((l) => l.includes('disconnect') && l.includes('transport close')));
  check('monitor mostra a sala "pausada"',
    await waitFor(() => mon.got.rooms?.find((r) => r.code === m.code)?.state === ROOM_STATES.PAUSED));
  check('monitor destaca a queda (tag "queda")', mon.got.logs.some((e) => e.tag === 'queda'));
  await sleep(1500);
  check('cliente NÃO reconecta sozinho enquanto a queda está simulada', !m.A.socket.connected);
  m.A.socket.io.reconnection(true);
  m.A.socket.connect();
  await m.A.connected();
  m.A.send(C.REJOIN, { sessionToken: m.token, code: m.code });
  await m.A.next(S.STATE_SYNC);
  const r1 = await m.A.next(S.MATCH_RESUME);
  const r2 = await m.B.next(S.MATCH_RESUME);
  check('"Reconectar" retoma: match_resume igual para os dois', r1.resumeAt === r2.resumeAt);
  check('monitor destaca a retomada (tag "retomada")', mon.got.logs.some((e) => e.tag === 'retomada'));

  for (const c of [m.A, m.B]) c.close();
  intruder.socket.close();
  mon.socket.close();
}
