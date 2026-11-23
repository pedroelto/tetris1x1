// Power-up disputado. Usado pelo servidor (regras e tempos) e pelo cliente
// (saber quando pedir e o que mostrar). Quem decide tudo é o servidor.

export const POWERUP_TYPES = {
  SHIELD: 'escudo', // bloqueia por inteiro o próximo ataque que entraria na sua fila
  DOUBLE: 'dobro',  // dobra o seu próximo ataque (antes do cancelamento)
};

// Tempos padrão (o servidor permite sobrescrever por variável de ambiente
// para os testes rodarem rápido; ver server/powerups.js).
export const POWERUP_SPAWN_MIN_MS = 20000; // intervalo mínimo até surgir
export const POWERUP_SPAWN_MAX_MS = 30000; // intervalo máximo até surgir
export const POWERUP_DURATION_MS = 15000;  // tempo até expirar se ninguém pegar

// Para pegar: limpar pelo menos isto de linhas de uma vez com o power-up ativo.
export const POWERUP_MIN_LINES = 2;

// Motivos de recusa enviados em powerup_denied.
export const DENY_REASONS = {
  EXPIRED: 'expirado',
  UNKNOWN: 'inexistente',
  TAKEN: 'o adversário pegou primeiro',
  ALREADY_YOURS: 'você já pegou',
  INVALID: 'pedido inválido',
};
