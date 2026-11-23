// Regras de ataque (linhas de lixo). Usadas pelo SERVIDOR para calcular o
// ataque: o cliente só informa quantas linhas limpou, nunca quanto lixo mandar.

// Tempo que um ataque fica "a caminho" antes de poder entrar no tabuleiro
// do adversário. Nessa janela ele ainda pode ser cancelado por um contra-ataque.
export const GARBAGE_DELAY_MS = 500;

// Linhas de lixo enviadas por número de linhas limpas de uma vez.
// Índice = linhas limpas (0 a 4). Para estender (combo, T-spin...),
// basta trocar attackFor por uma função que considere mais informações.
export const ATTACK_TABLE = [
  0, // 0 linhas
  0, // 1 linha (single)
  1, // 2 linhas (double)
  2, // 3 linhas (triple)
  4, // 4 linhas (tetris)
];

export function attackFor(linesCleared) {
  return ATTACK_TABLE[linesCleared] ?? 0;
}

export const MAX_LINES_CLEARED = ATTACK_TABLE.length - 1;
