// Monitor do servidor (/monitor): ferramenta de demonstração, fora do jogo.
// Recebe em tempo real o log e um retrato das salas, e pode forçar um
// power-up. Não altera nenhuma regra do jogo nem do protocolo dos jogadores.
//
// Acesso (ver monitorMode):
//   - com a variável de ambiente MONITOR_KEY definida: /monitor?key=<MONITOR_KEY>
//   - sem ela, em desenvolvimento: só conexões vindas da própria máquina
//   - sem ela, em produção (NODE_ENV=production): monitor desativado
//
// "Vindas da própria máquina" usa o endereço da conexão TCP
// (req.socket.remoteAddress / handshake.address), NUNCA cabeçalhos como
// X-Forwarded-For, que qualquer cliente pode forjar. Atrás do proxy do
// Render, toda conexão chega do proxy; por isso em produção a checagem por
// localhost não é usada e a chave é obrigatória.

import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MONITOR_ROOM, MONITOR_EVENTS as M } from '../shared/protocol.js';
import { setLogSink, getLogHistory } from './logger.js';
import { getRoomsSnapshot, forcePowerupInRoom } from './rooms.js';

const MONITOR_PAGE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'monitor.html');
const SNAPSHOT_INTERVAL_MS = 500;
const LOCAL_ADDRESSES = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

// Compara em tempo constante (não vaza, pelo tempo de resposta, quantos
// caracteres da chave estavam certos).
function sameKey(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

// 'key' | 'local' | 'disabled'
export function monitorMode() {
  if (process.env.MONITOR_KEY) return 'key';
  return process.env.NODE_ENV === 'production' ? 'disabled' : 'local';
}

// Devolve null se o acesso é permitido, ou o motivo da recusa.
function checkAccess(key, address) {
  const mode = monitorMode();
  if (mode === 'disabled') return 'monitor desativado (defina MONITOR_KEY)';
  if (mode === 'key') return sameKey(key, process.env.MONITOR_KEY) ? null : 'chave inválida';
  return LOCAL_ADDRESSES.includes(address) ? null : 'sem MONITOR_KEY, só é aceito acesso local';
}

export function setupMonitor(app, io) {
  // A página em si (o HTML fica fora de /client para não ser servido sem checagem).
  app.get('/monitor', (req, res) => {
    if (monitorMode() === 'disabled') return res.status(404).send('Monitor desativado.');
    const denied = checkAccess(req.query.key, req.socket.remoteAddress);
    if (denied) return res.status(403).send(`Acesso negado: ${denied}`);
    res.sendFile(MONITOR_PAGE);
  });

  // Cada entrada de log vai, em tempo real, para todos os monitores conectados.
  setLogSink((entry) => io.to(MONITOR_ROOM).emit(M.LOG, entry));

  // Retrato das salas a cada 500 ms (só se houver algum monitor conectado).
  setInterval(() => {
    if (io.sockets.adapter.rooms.get(MONITOR_ROOM)?.size) {
      io.to(MONITOR_ROOM).emit(M.ROOMS, getRoomsSnapshot());
    }
  }, SNAPSHOT_INTERVAL_MS).unref();
}

// Conexão Socket.IO com auth.role === 'monitor'. Nunca vira jogador.
export function handleMonitorConnection(socket) {
  const denied = checkAccess(socket.handshake.auth?.key, socket.handshake.address);
  if (denied) {
    socket.emit(M.ERROR, { reason: denied });
    socket.disconnect(true);
    return;
  }

  socket.join(MONITOR_ROOM);
  socket.emit(M.HISTORY, getLogHistory());
  socket.emit(M.ROOMS, getRoomsSnapshot());

  // Só sockets de monitor autenticados têm este handler: um jogador que
  // emitir o mesmo evento não é ouvido por ninguém.
  socket.on(M.FORCE_POWERUP, ({ code } = {}) => {
    const error = forcePowerupInRoom(code);
    socket.emit(M.FORCE_RESULT, { code, ok: !error, message: error ?? 'power-up criado' });
  });
}
