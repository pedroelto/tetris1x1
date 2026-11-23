// Definição das 7 peças e das tabelas de "wall kick" do SRS
// (Super Rotation System, o padrão oficial de rotação do Tetris).

// Formato de cada peça no estado de rotação 0 (como ela nasce).
const BASE_SHAPES = {
  I: [
    [0, 0, 0, 0],
    [1, 1, 1, 1],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ],
  O: [
    [1, 1],
    [1, 1],
  ],
  T: [
    [0, 1, 0],
    [1, 1, 1],
    [0, 0, 0],
  ],
  S: [
    [0, 1, 1],
    [1, 1, 0],
    [0, 0, 0],
  ],
  Z: [
    [1, 1, 0],
    [0, 1, 1],
    [0, 0, 0],
  ],
  J: [
    [1, 0, 0],
    [1, 1, 1],
    [0, 0, 0],
  ],
  L: [
    [0, 0, 1],
    [1, 1, 1],
    [0, 0, 0],
  ],
};

export const PIECE_TYPES = Object.keys(BASE_SHAPES); // ['I','O','T','S','Z','J','L']

// Gira uma matriz quadrada 90° no sentido horário.
// No SRS, girar a matriz inteira (4x4 para o I, 3x3 para as demais)
// produz exatamente os estados oficiais de rotação.
function rotateClockwise(matrix) {
  const n = matrix.length;
  return matrix.map((row, r) => row.map((_, c) => matrix[n - 1 - c][r]));
}

// PIECES[tipo] = { size, rotations: [estado0, estadoR, estado2, estadoL] }
export const PIECES = {};
for (const type of PIECE_TYPES) {
  const rotations = [BASE_SHAPES[type]];
  for (let i = 1; i < 4; i++) rotations.push(rotateClockwise(rotations[i - 1]));
  PIECES[type] = { size: BASE_SHAPES[type].length, rotations };
}

// Tabelas de wall kick do SRS. Estados: 0 = spawn, 1 = R, 2 = 180°, 3 = L.
// Os deslocamentos estão na notação oficial (x para direita, y PARA CIMA);
// a engine inverte o y porque no tabuleiro o y cresce para baixo.
const KICKS_JLSTZ = {
  '0>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '1>0': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '1>2': [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
  '2>1': [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
  '2>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
  '3>2': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '3>0': [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
  '0>3': [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
};

const KICKS_I = {
  '0>1': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '1>0': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  '1>2': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
  '2>1': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '2>3': [[0, 0], [2, 0], [-1, 0], [2, 1], [-1, -2]],
  '3>2': [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2]],
  '3>0': [[0, 0], [1, 0], [-2, 0], [1, -2], [-2, 1]],
  '0>3': [[0, 0], [-1, 0], [2, 0], [-1, 2], [2, -1]],
};

// Retorna a lista de deslocamentos a testar ao girar de `from` para `to`.
export function getKicks(type, from, to) {
  if (type === 'O') return [[0, 0]]; // O não precisa de kick
  // O SRS oficial não define kicks para giro de 180°: testamos só a posição atual.
  if (Math.abs(to - from) === 2) return [[0, 0]];
  const table = type === 'I' ? KICKS_I : KICKS_JLSTZ;
  return table[`${from}>${to}`];
}
