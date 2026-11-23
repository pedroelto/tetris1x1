// Camada de rede do cliente: conexão Socket.IO, número de sequência
// e sincronização de relógio (algoritmo de Cristian).
// `io` é global, carregado por <script src="/socket.io/socket.io.js">.
//
// Fase 6: TODA mensagem enviada ou recebida passa por latency.schedule(),
// o único ponto onde a latência artificial (painel F2) é aplicada.

import { CLIENT_EVENTS, SERVER_EVENTS, CLOCK_SYNC_SAMPLES } from '/shared/protocol.js';
import { createLatencySimulator } from './latency.js';

const socket = io();
const latency = createLatencySimulator();
let seq = 0;
let dropSimulated = false;

// Diferença estimada entre o relógio do servidor e o nosso:
//   horaServidor ≈ Date.now() + clockOffset
export const clock = { offset: 0, rtt: null };

// Toda mensagem enviada ao servidor ganha um seq crescente (no momento do
// envio, antes da latência: é isso que permite ver a reordenação no servidor).
// Desconectado, a mensagem é descartada aqui mesmo (o jogo está pausado e o
// estado é ressincronizado no rejoin). Sem isso, o Socket.IO guardaria a
// mensagem e a enviaria ao reconectar ANTES do rejoin.
export function send(eventName, data = {}) {
  if (!socket.connected) {
    console.warn(`[rede] desconectado: "${eventName}" não enviado`);
    return;
  }
  seq++;
  const payload = { ...data, seq };
  latency.schedule('out', () => {
    // A conexão pode ter caído enquanto a mensagem "viajava".
    if (socket.connected) socket.emit(eventName, payload);
  });
}

// Depois de recarregar a página o contador recomeça em 0, mas o servidor
// lembra o último seq aceito. O state_sync informa esse valor e continuamos dele.
export function continueSeqFrom(lastSeq) {
  seq = Math.max(seq, lastSeq);
}

export function lastSentSeq() {
  return seq;
}

export function on(eventName, callback) {
  socket.on(eventName, (data) => latency.schedule('in', () => callback(data)));
}

export function serverNow() {
  return Date.now() + clock.offset;
}

// Algoritmo de Cristian:
//   1. guarda a hora local t0 e envia um ping
//   2. o servidor responde com a hora dele (serverTime)
//   3. ao receber em t1:  RTT = t1 - t0
//                         offset = serverTime + RTT/2 - t1
// Repete CLOCK_SYNC_SAMPLES vezes e fica com o ping de MENOR RTT,
// que é o que tem menos incerteza (menos tempo "perdido" na rede).
// Com latência simulada, o RTT medido inclui o atraso de ida e de volta.
const PING_TIMEOUT_MS = 3000;

function pingOnce() {
  return new Promise((resolve) => {
    const handler = (msg) => latency.schedule('in', () => {
      clearTimeout(timer);
      const t1 = Date.now();
      const rtt = t1 - msg.clientTime;
      resolve({ rtt, offset: msg.serverTime + rtt / 2 - t1 });
    });
    // Sem resposta (ex.: ping descartado por estar fora de ordem): desiste deste.
    const timer = setTimeout(() => {
      socket.off(SERVER_EVENTS.TIME_PONG, handler);
      resolve(null);
    }, PING_TIMEOUT_MS);
    socket.once(SERVER_EVENTS.TIME_PONG, handler);
    send(CLIENT_EVENTS.TIME_PING, { clientTime: Date.now() });
  });
}

let syncing = null; // evita duas sincronizações ao mesmo tempo

export function syncClock() {
  syncing ??= (async () => {
    let best = null;
    for (let i = 0; i < CLOCK_SYNC_SAMPLES; i++) {
      const sample = await pingOnce();
      if (!sample) continue;
      console.log(`[relógio] ping ${i + 1}: RTT=${sample.rtt} ms, offset=${sample.offset.toFixed(1)} ms`);
      if (!best || sample.rtt < best.rtt) best = sample;
    }
    if (best) {
      clock.rtt = best.rtt;
      clock.offset = best.offset;
    }
    return { rtt: clock.rtt, offset: clock.offset };
  })().finally(() => { syncing = null; });
  return syncing;
}

export function onConnect(callback) {
  socket.on('connect', callback);
}

export function onDisconnect(callback) {
  socket.on('disconnect', callback);
}

export function isConnected() {
  return socket.connected;
}

// ---------- Ferramentas de demonstração (painel F2) ----------

export const latencySettings = latency.settings;

export function setLatency(settings) {
  latency.set(settings);
}

// Derruba o transporte de forma abrupta: fecha a conexão por baixo do
// Socket.IO, sem mandar o "disconnect" de saída voluntária. O servidor vê
// "transport close" e segue o caminho de falha (pausa, reconexão, W.O.).
// A reconexão automática fica desligada até o botão "Reconectar".
export function simulateDrop() {
  if (!socket.connected) return;
  dropSimulated = true;
  socket.io.reconnection(false);
  socket.io.engine.close();
}

export function reconnect() {
  dropSimulated = false;
  socket.io.reconnection(true);
  if (!socket.connected) socket.connect();
}

export function isDropSimulated() {
  return dropSimulated;
}
