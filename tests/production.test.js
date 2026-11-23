// Testes do modo produção (fase 7): node tests/production.test.js
// Sobe o servidor como no Render (NODE_ENV=production) e confere health
// check, versão, regras do monitor e que o jogo funciona igual.

import { io } from 'socket.io-client';
import { CLIENT_EVENTS as C, SERVER_EVENTS as S, MONITOR_EVENTS as M } from '../shared/protocol.js';
import { createBoard } from '../shared/engine.js';
import { check, section, finish, sleep, createClient, startServer } from './helpers.js';

const KEY = 'chave-prod';
const servers = [];

let exitCode = 1;
try {
  await run();
  exitCode = finish();
} catch (err) {
  console.error('\nErro durante os testes:', err.message);
} finally {
  for (const s of servers) s.stop();
  process.exit(exitCode);
}

// Conecta como monitor e devolve o que recebeu em 300 ms.
async function tryMonitor(url, key) {
  const socket = io(url, { auth: { role: 'monitor', key }, transports: ['websocket'], forceNew: true });
  const got = { error: null, history: null };
  socket.on(M.ERROR, (e) => { got.error = e.reason; });
  socket.on(M.HISTORY, (h) => { got.history = h; });
  await sleep(300);
  socket.close();
  return got;
}

async function run() {
  section('1. Produção SEM MONITOR_KEY: monitor desativado, jogo funcionando');
  let server = await startServer(3996, { NODE_ENV: 'production', MONITOR_KEY: '' });
  servers.push(server);
  let url = 'http://localhost:3996';

  let res = await fetch(`${url}/health`);
  const health = await res.json();
  check('/health responde 200 com status ok', res.status === 200 && health.status === 'ok');
  check('versão local é "dev"', health.version === 'dev');
  check('log do servidor informa modo e versão',
    server.log.some((l) => l.includes('NODE_ENV=production') && l.includes('monitor: disabled')));

  res = await fetch(`${url}/monitor`);
  check('/monitor desativado (404) mesmo vindo de localhost', res.status === 404);
  res = await fetch(`${url}/monitor`, { headers: { 'X-Forwarded-For': '127.0.0.1' } });
  check('X-Forwarded-For: 127.0.0.1 não libera o monitor', res.status === 404);
  const mon = await tryMonitor(url, '');
  check('socket de monitor recusado: "monitor desativado"', mon.error?.startsWith('monitor desativado') && !mon.history);

  // Partida curta: criar, entrar, começar, trocar tabuleiro.
  const A = createClient(url, 'A');
  const B = createClient(url, 'B');
  await A.connected();
  await B.connected();
  A.send(C.CREATE_ROOM, { nickname: 'Ana' });
  const { code } = await A.next(S.ROOM_JOINED);
  B.send(C.JOIN_ROOM, { nickname: 'Beto', code });
  await B.next(S.ROOM_JOINED);
  A.send(C.PLAYER_READY);
  B.send(C.PLAYER_READY);
  const startA = await A.next(S.GAME_START);
  const startB = await B.next(S.GAME_START);
  check('partida começa com a mesma semente', startA.seed === startB.seed);
  await sleep(3150);
  A.send(C.PIECE_LOCKED, {
    board: createBoard(), linesCleared: 0, hold: null, piecesLocked: 1, score: 0, lines: 0,
  });
  check('tabuleiro chega ao adversário', (await B.next(S.OPPONENT_BOARD)).board.length === 20);
  A.close();
  B.close();
  server.stop();

  section('2. Produção COM MONITOR_KEY e commit do Render');
  server = await startServer(3995, {
    NODE_ENV: 'production', MONITOR_KEY: KEY, RENDER_GIT_COMMIT: 'abcdef1234567890',
  });
  servers.push(server);
  url = 'http://localhost:3995';

  res = await fetch(`${url}/version`);
  check('versão = hash curto do commit (abcdef1)', (await res.json()).version === 'abcdef1');
  res = await fetch(`${url}/monitor`);
  check('/monitor sem chave => 403 (localhost não basta em produção)', res.status === 403);
  res = await fetch(`${url}/monitor?key=${KEY}`);
  check('/monitor com a chave => 200', res.status === 200);
  check('socket de monitor com a chave recebe o histórico', Array.isArray((await tryMonitor(url, KEY)).history));
  check('socket de monitor com chave errada é recusado', (await tryMonitor(url, 'x')).error === 'chave inválida');
  server.stop();

  section('3. Desenvolvimento sem chave: decisão pelo endereço TCP, não por cabeçalho');
  server = await startServer(3994, { NODE_ENV: 'development', MONITOR_KEY: '' });
  servers.push(server);
  url = 'http://localhost:3994';
  res = await fetch(`${url}/monitor`, { headers: { 'X-Forwarded-For': '203.0.113.9' } });
  check('cabeçalho dizendo "IP externo" não muda nada: conexão local é aceita', res.status === 200);
  server.stop();
}
