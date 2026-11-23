// Configuração do servidor que pode ser sobrescrita por variável de ambiente
// (usado pelos testes para encurtar tempos). Os valores padrão ficam em /shared.

import { RECONNECT_TIMEOUT_MS } from '../shared/protocol.js';
import {
  POWERUP_SPAWN_MIN_MS, POWERUP_SPAWN_MAX_MS, POWERUP_DURATION_MS,
} from '../shared/powerups.js';

function envMs(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export const config = {
  reconnectTimeoutMs: envMs('RECONNECT_TIMEOUT_MS', RECONNECT_TIMEOUT_MS),
  powerupSpawnMinMs: envMs('POWERUP_SPAWN_MIN_MS', POWERUP_SPAWN_MIN_MS),
  powerupSpawnMaxMs: envMs('POWERUP_SPAWN_MAX_MS', POWERUP_SPAWN_MAX_MS),
  powerupDurationMs: envMs('POWERUP_DURATION_MS', POWERUP_DURATION_MS),
};
