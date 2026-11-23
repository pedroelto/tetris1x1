// Utilitários dos testes: verificação simples e clientes Socket.IO simulados.

import { io } from 'socket.io-client';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Sobe o servidor do jogo num processo separado e espera ele ficar pronto.
// Devolve { log, stop } — `log` acumula as linhas impressas pelo servidor.
export async function startServer(port, env = {}) {
  const log = [];
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: rootDir,
    env: { ...process.env, PORT: String(port), ...env },
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => log.push(...chunk.split('\n').filter(Boolean)));
  child.stderr.pipe(process.stderr);
  while (!log.some((l) => l.includes('Servidor rodando'))) await sleep(20);
  return { log, stop: () => child.kill() };
}

let failures = 0;

export function check(label, condition) {
  console.log(`${condition ? '  ok   ' : '  FALHA'} ${label}`);
  if (!condition) failures++;
}

export function section(title) {
  console.log(`\n${title}`);
}

export function finish() {
  console.log(failures === 0 ? '\nTodos os testes passaram.' : `\n${failures} teste(s) falharam.`);
  return failures === 0 ? 0 : 1;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Cliente simulado: guarda tudo que recebe e numera o que envia (seq).
export function createClient(url, name) {
  const socket = io(url, { transports: ['websocket'], forceNew: true });
  const received = [];
  socket.onAny((event, data) => received.push({ event, data, used: false }));
  let seq = 0;

  return {
    name,
    socket,
    received,
    send(event, data = {}) {
      socket.emit(event, { ...data, seq: ++seq });
    },
    get seq() {
      return seq;
    },
    // Continua a numeração a partir do lastSeq do state_sync (como o cliente real).
    continueSeqFrom(lastSeq) {
      seq = Math.max(seq, lastSeq);
    },
    // Espera o socket conectar (útil depois de socket.connect()).
    async connected(timeoutMs = 3000) {
      const start = Date.now();
      while (!socket.connected) {
        if (Date.now() - start > timeoutMs) throw new Error(`${name}: não conectou`);
        await sleep(10);
      }
    },
    // Envia com o seq que quisermos (para testar descarte).
    sendRaw(event, data) {
      socket.emit(event, data);
    },
    // Espera a próxima mensagem `event` ainda não consumida.
    async next(event, timeoutMs = 2000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const msg = received.find((m) => m.event === event && !m.used);
        if (msg) {
          msg.used = true;
          return msg.data;
        }
        await sleep(5);
      }
      throw new Error(`${name}: tempo esgotado esperando "${event}"`);
    },
    // Descarta mensagens ainda não lidas (para começar um cenário "limpo").
    clear() {
      for (const m of received) m.used = true;
    },
    // Última mensagem `event` recebida (lida ou não), ou undefined.
    last(event) {
      return [...received].reverse().find((m) => m.event === event)?.data;
    },
    count(event) {
      return received.filter((m) => m.event === event && !m.used).length;
    },
    close() {
      socket.disconnect();
    },
  };
}
