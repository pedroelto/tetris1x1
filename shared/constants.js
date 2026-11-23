// Constantes do jogo, compartilhadas entre servidor e cliente.

export const COLS = 10;
export const ROWS = 20;

// Tempo (ms) que a peça pode ficar encostada no chão antes de travar.
export const LOCK_DELAY_MS = 500;

// Quantas vezes mover/girar a peça no chão reinicia o lock delay
// (evita que o jogador "segure" a peça para sempre).
export const MAX_LOCK_RESETS = 15;

// Pontos por número de linhas limpas de uma vez (multiplicado pelo nível).
export const LINE_SCORES = [0, 100, 300, 500, 800];

// Linhas necessárias para subir de nível.
export const LINES_PER_LEVEL = 10;

// Valor gravado no tabuleiro para células de lixo (garbage).
export const GARBAGE_CELL = 'G';

// Intervalo (ms) entre quedas automáticas, diminuindo a cada nível.
export function gravityInterval(level) {
  return Math.max(50, Math.round(1000 * Math.pow(0.8, level - 1)));
}
