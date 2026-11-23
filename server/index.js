// Servidor HTTP + Socket.IO, na mesma porta.
//   /            -> pasta client
//   /shared/     -> pasta shared (engine e protocolo usados pelo navegador)
//   /socket.io/  -> biblioteca cliente do Socket.IO (servida automaticamente)
//   /monitor     -> monitor do servidor (ferramenta de demonstração, com chave)
//   /health      -> health check (usado pelo Render)
//   /version     -> versão do build (hash do commit no Render, "dev" local)

import express from 'express';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_TIMEOUT_MS } from '../shared/protocol.js';
import { handleConnection } from './rooms.js';
import { setupMonitor, handleMonitorConnection, monitorMode } from './monitor.js';
import { BUILD_VERSION } from './version.js';

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// O Render informa a porta pela variável PORT; localmente, 3000.
const PORT = process.env.PORT || 3000;

const app = express();
// Não configuramos "trust proxy": nada no servidor confia em cabeçalhos como
// X-Forwarded-For, que qualquer cliente pode forjar.

app.get('/health', (req, res) => res.json({ status: 'ok', version: BUILD_VERSION }));
app.get('/version', (req, res) => res.json({ version: BUILD_VERSION }));

const httpServer = createServer(app);
// Heartbeat curto para detectar queda em poucos segundos (padrão do Socket.IO: ~45 s).
const io = new Server(httpServer, {
  pingInterval: HEARTBEAT_INTERVAL_MS,
  pingTimeout: HEARTBEAT_TIMEOUT_MS,
});

setupMonitor(app, io);
app.use(express.static(path.join(rootDir, 'client')));
app.use('/shared', express.static(path.join(rootDir, 'shared')));

// Conexões de monitor e de jogador chegam pelo mesmo Socket.IO; o monitor se
// identifica no handshake (auth.role) e nunca passa pelo código do jogo.
io.on('connection', (socket) => {
  if (socket.handshake.auth?.role === 'monitor') handleMonitorConnection(socket);
  else handleConnection(socket);
});

httpServer.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
  console.log(`Versão ${BUILD_VERSION} · NODE_ENV=${process.env.NODE_ENV ?? '(não definido)'} · monitor: ${monitorMode()}`);
});
