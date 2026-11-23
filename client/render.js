// Desenho do jogo em Canvas. Só lê o estado da engine, nunca o altera.

import { COLS, ROWS } from '/shared/constants.js';
import { PIECES } from '/shared/pieces.js';

const CELL = 30;      // tamanho da célula no tabuleiro (px)
const MINI_CELL = 24; // tamanho da célula nos previews (px)

const COLORS = {
  I: '#3ad6e8',
  O: '#f2d43a',
  T: '#b45ce6',
  S: '#5cd65c',
  Z: '#e8504a',
  J: '#4a72e8',
  L: '#f0973a',
  G: '#6b6d7a', // lixo
};

function drawCell(ctx, x, y, size, color) {
  ctx.fillStyle = color;
  ctx.fillRect(x * size + 1, y * size + 1, size - 2, size - 2);
}

// Grade de fundo + blocos já travados. `size` = tamanho da célula em px.
function drawGridAndCells(ctx, board, size) {
  ctx.clearRect(0, 0, COLS * size, ROWS * size);

  ctx.strokeStyle = '#1a1b24';
  for (let x = 0; x <= COLS; x++) {
    ctx.beginPath();
    ctx.moveTo(x * size, 0);
    ctx.lineTo(x * size, ROWS * size);
    ctx.stroke();
  }
  for (let y = 0; y <= ROWS; y++) {
    ctx.beginPath();
    ctx.moveTo(0, y * size);
    ctx.lineTo(COLS * size, y * size);
    ctx.stroke();
  }

  board.forEach((row, y) => row.forEach((cell, x) => {
    if (cell) drawCell(ctx, x, y, size, COLORS[cell]);
  }));
}

// Tabuleiro do adversário: só os blocos travados (recebidos do servidor).
export function drawOpponentBoard(ctx, board) {
  const size = ctx.canvas.width / COLS;
  drawGridAndCells(ctx, board, size);
}

// Tabuleiro do jogador local, com sombra e peça ativa.
export function drawBoard(ctx, game) {
  drawGridAndCells(ctx, game.board, CELL);
  if (game.isOver) return;

  // Sombra (onde a peça vai cair) e peça ativa
  const ghost = { ...game.piece, y: game.getGhostY() };
  ctx.globalAlpha = 0.25;
  for (const { x, y } of game.cellsOf(ghost)) {
    if (y >= 0) drawCell(ctx, x, y, CELL, COLORS[ghost.type]);
  }
  ctx.globalAlpha = 1;

  for (const { x, y } of game.cellsOf(game.piece)) {
    if (y >= 0) drawCell(ctx, x, y, CELL, COLORS[game.piece.type]);
  }
}

// Barra de lixo pendente, de baixo para cima, 1 célula por linha de lixo.
// entries: [{ lines, readyAt }] (readyAt no relógio do servidor).
export function drawGarbageBar(ctx, entries, serverNow) {
  const { width, height } = ctx.canvas;
  ctx.clearRect(0, 0, width, height);

  let bottom = height;
  for (const { lines, readyAt } of entries) {
    const h = Math.min(lines * CELL, bottom);
    ctx.fillStyle = readyAt <= serverNow ? '#e8504a' : '#6e3432'; // pronto : a caminho
    ctx.fillRect(0, bottom - h + 1, width, h - 2);
    bottom -= h;
    if (bottom <= 0) break;
  }
}

// Desenha uma peça centralizada num canvas pequeno (próxima peça / hold).
export function drawPreview(ctx, type, dimmed = false) {
  const { width, height } = ctx.canvas;
  ctx.clearRect(0, 0, width, height);
  if (!type) return;

  const matrix = PIECES[type].rotations[0];
  // Ignora linhas vazias da matriz para centralizar corretamente.
  const rows = matrix.filter((row) => row.some(Boolean));
  const cols = matrix[0].length;
  const offsetX = (width - cols * MINI_CELL) / 2;
  const offsetY = (height - rows.length * MINI_CELL) / 2;

  ctx.save();
  ctx.translate(offsetX, offsetY);
  ctx.globalAlpha = dimmed ? 0.35 : 1;
  rows.forEach((row, y) => row.forEach((filled, x) => {
    if (filled) drawCell(ctx, x, y, MINI_CELL, COLORS[type]);
  }));
  ctx.restore();
}
