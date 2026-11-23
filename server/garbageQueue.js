// Fila de lixo pendente de um jogador (estado que só existe no servidor).
// Cada entrada: { lines, holeCol, readyAt }
//   lines   - quantas linhas de lixo
//   holeCol - coluna do buraco (igual para todas as linhas do mesmo ataque)
//   readyAt - instante (relógio do servidor) a partir do qual pode entrar no tabuleiro
// A fila é um array em ordem de chegada: a entrada mais antiga fica em queue[0].

import { COLS } from '../shared/constants.js';
import { GARBAGE_DELAY_MS } from '../shared/garbage.js';

// Cria uma entrada nova com buraco sorteado pelo servidor.
export function createEntry(lines, now) {
  return { lines, holeCol: Math.floor(Math.random() * COLS), readyAt: now + GARBAGE_DELAY_MS };
}

// Cancelamento: o ataque abate a fila do próprio atacante, das entradas mais
// antigas para as mais novas (prontas ou não). Altera a fila e devolve
// quantas linhas foram canceladas.
export function cancelFromQueue(queue, attack) {
  let cancelled = 0;
  while (attack > 0 && queue.length > 0) {
    const oldest = queue[0];
    const amount = Math.min(oldest.lines, attack);
    oldest.lines -= amount;
    attack -= amount;
    cancelled += amount;
    if (oldest.lines === 0) queue.shift();
  }
  return cancelled;
}

// Remove da fila e devolve as entradas já prontas (readyAt <= now).
// Depois disso elas não podem mais ser canceladas.
export function takeReady(queue, now) {
  const ready = queue.filter((e) => e.readyAt <= now);
  const waiting = queue.filter((e) => e.readyAt > now);
  queue.splice(0, queue.length, ...waiting);
  return ready;
}

// Resumo enviado ao cliente em garbage_queue.
export function summarize(queue, now) {
  const total = (entries) => entries.reduce((sum, e) => sum + e.lines, 0);
  return {
    pending: total(queue),
    ready: total(queue.filter((e) => e.readyAt <= now)),
    entries: queue.map((e) => ({ lines: e.lines, readyAt: e.readyAt })),
  };
}

// Texto legível para o log, ex.: "[2 col4 pronto, 1 col7 em 320ms]"
export function formatQueue(queue, now) {
  const items = queue.map((e) => {
    const when = e.readyAt <= now ? 'pronto' : `em ${e.readyAt - now}ms`;
    return `${e.lines} col${e.holeCol} ${when}`;
  });
  return `[${items.join(', ')}]`;
}
