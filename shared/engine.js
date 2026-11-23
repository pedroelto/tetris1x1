// Engine do Tetris: lógica pura, sem DOM e sem rede.
// Pode rodar no navegador (jogo local) e no Node (servidor, testes).
//
// Quem usa a engine:
//   - chama os comandos (move, rotate, softDrop, hardDrop, hold)
//   - chama update(dt) a cada frame para aplicar a gravidade
//   - escuta os eventos em GAME_EVENTS para reagir ao que aconteceu

import {
  COLS, ROWS, LOCK_DELAY_MS, MAX_LOCK_RESETS, LINE_SCORES,
  LINES_PER_LEVEL, GARBAGE_CELL, gravityInterval,
} from './constants.js';
import { PIECES, getKicks } from './pieces.js';
import { PieceGenerator } from './random.js';
import { Emitter } from './emitter.js';

export const GAME_EVENTS = {
  PIECE_LOCKED: 'pieceLocked',   // { type, linesCleared }
  LINES_CLEARED: 'linesCleared', // { count }
  GAME_OVER: 'gameOver',         // { score, lines }
};

// Tabuleiro = matriz ROWS x COLS. Cada célula é null (vazia)
// ou uma string com o tipo da peça ('I', 'T', ... ou 'G' para lixo).
export function createBoard() {
  return Array.from({ length: ROWS }, () => Array(COLS).fill(null));
}

// Função pura: devolve um NOVO tabuleiro empurrado para cima com `count`
// linhas de lixo na base (buraco em `holeCol`). `overflow` indica que havia
// blocos nas linhas que saíram por cima (o jogador perde).
// Usada pela engine e pelo servidor (para manter o checkpoint atualizado).
export function pushGarbage(board, count, holeCol) {
  const overflow = board.slice(0, count).some((row) => row.some((cell) => cell !== null));
  const newBoard = board.slice(count).map((row) => [...row]);
  for (let i = 0; i < count; i++) {
    const row = Array(COLS).fill(GARBAGE_CELL);
    row[holeCol] = null;
    newBoard.push(row);
  }
  return { board: newBoard, overflow };
}

export class TetrisGame extends Emitter {
  constructor(seed) {
    super();
    this.board = createBoard();
    this.generator = new PieceGenerator(seed);
    this.nextType = this.generator.next();
    this.holdType = null;
    this.canHold = true; // só pode usar hold uma vez por peça

    this.score = 0;
    this.lines = 0;
    this.level = 1;
    this.piecesLocked = 0; // usado para reconstruir o jogo a partir de um checkpoint
    this.isOver = false;

    this.piece = null; // peça ativa: { type, rotation, x, y }
    this.spawn(this.takeNext());
  }

  // Reconstrói um jogo a partir de um checkpoint (enviado no piece_locked).
  // Como a sequência de peças é determinística (mesma semente), basta
  // "pular" no gerador as peças que já foram usadas.
  static fromCheckpoint(seed, { board, hold, piecesLocked, score, lines }) {
    const game = new TetrisGame(seed);
    game.board = board.map((row) => [...row]);
    game.holdType = hold;
    game.piecesLocked = piecesLocked;
    game.score = score;
    game.lines = lines;
    game.level = Math.floor(lines / LINES_PER_LEVEL) + 1;

    // Peças já tiradas do gerador = as travadas + a que está no hold
    // (o primeiro hold puxa uma peça nova do gerador).
    game.generator = new PieceGenerator(seed);
    const used = piecesLocked + (hold ? 1 : 0);
    for (let i = 0; i < used; i++) game.generator.next();

    const current = game.generator.next();
    game.nextType = game.generator.next();
    game.canHold = true;
    game.spawn(current);
    return game;
  }

  // ---------- Comandos do jogador ----------

  // Retorna true se a peça conseguiu se mover.
  move(dx) {
    if (this.isOver) return false;
    if (!this.tryMove(dx, 0)) return false;
    this.onPieceMoved();
    return true;
  }

  // dir = +1 (horário), -1 (anti-horário) ou 2 (180°)
  rotate(dir) {
    if (this.isOver) return;
    const from = this.piece.rotation;
    const to = (from + dir + 4) % 4;

    // Testa cada deslocamento do SRS até achar uma posição livre.
    for (const [kx, ky] of getKicks(this.piece.type, from, to)) {
      const candidate = { ...this.piece, rotation: to, x: this.piece.x + kx, y: this.piece.y - ky };
      if (!this.collides(candidate)) {
        this.piece = candidate;
        this.onPieceMoved();
        return;
      }
    }
  }

  softDrop() {
    if (this.isOver) return;
    if (this.tryMove(0, 1)) {
      this.score += 1;
      this.dropTimer = 0;
    }
  }

  hardDrop() {
    if (this.isOver) return;
    while (this.tryMove(0, 1)) this.score += 2;
    this.lockPiece();
  }

  hold() {
    if (this.isOver || !this.canHold) return;
    const current = this.piece.type;
    if (this.holdType === null) {
      this.holdType = current;
      this.spawn(this.takeNext());
    } else {
      const swapped = this.holdType;
      this.holdType = current;
      this.spawn(swapped);
    }
    this.canHold = false;
  }

  // ---------- Passagem do tempo ----------

  // dt = milissegundos desde o último frame.
  update(dt) {
    if (this.isOver) return;

    // Gravidade: desce uma linha a cada "interval" ms.
    this.dropTimer += dt;
    const interval = gravityInterval(this.level);
    while (this.dropTimer >= interval) {
      this.dropTimer -= interval;
      if (!this.tryMove(0, 1)) {
        this.dropTimer = 0;
        break;
      }
    }

    // Lock delay: se a peça está apoiada, conta o tempo até travar.
    if (this.isOnGround()) {
      this.lockTimer += dt;
      if (this.lockTimer >= LOCK_DELAY_MS) this.lockPiece();
    } else {
      this.lockTimer = 0;
    }
  }

  // ---------- Linhas de lixo (usado na fase 3) ----------

  // Empurra o tabuleiro para cima e adiciona `count` linhas cheias
  // na base, todas com um buraco na coluna `holeCol`.
  addGarbage(count, holeCol) {
    if (this.isOver || count <= 0) return;

    // Se houver blocos nas linhas que vão "sair por cima", o jogador perde.
    const result = pushGarbage(this.board, count, holeCol);
    this.board = result.board;
    const overflow = result.overflow;

    // Se a peça ativa ficou sobreposta ao lixo, sobe ela até ficar livre.
    while (this.collides(this.piece)) this.piece.y--;

    if (overflow) this.endGame();
  }

  // ---------- Consultas (usadas pela renderização) ----------

  // Lista as células ocupadas por uma peça: [{ x, y }, ...]
  cellsOf(piece) {
    const matrix = PIECES[piece.type].rotations[piece.rotation];
    const cells = [];
    matrix.forEach((row, r) => row.forEach((filled, c) => {
      if (filled) cells.push({ x: piece.x + c, y: piece.y + r });
    }));
    return cells;
  }

  // Linha onde a peça cairia com um hard drop (para desenhar a "sombra").
  getGhostY() {
    const ghost = { ...this.piece };
    while (!this.collides({ ...ghost, y: ghost.y + 1 })) ghost.y++;
    return ghost.y;
  }

  // ---------- Regras internas ----------

  // Uma peça colide se sair pelas laterais/fundo ou encostar em bloco.
  // Acima do topo (y < 0) é considerado espaço livre.
  collides(piece) {
    return this.cellsOf(piece).some(({ x, y }) =>
      x < 0 || x >= COLS || y >= ROWS || (y >= 0 && this.board[y][x] !== null));
  }

  tryMove(dx, dy) {
    const candidate = { ...this.piece, x: this.piece.x + dx, y: this.piece.y + dy };
    if (this.collides(candidate)) return false;
    this.piece = candidate;
    return true;
  }

  isOnGround() {
    return this.collides({ ...this.piece, y: this.piece.y + 1 });
  }

  // Mover/girar a peça apoiada reinicia o lock delay (com limite).
  onPieceMoved() {
    if (this.isOnGround() && this.lockResets < MAX_LOCK_RESETS) {
      this.lockTimer = 0;
      this.lockResets++;
    }
  }

  takeNext() {
    const type = this.nextType;
    this.nextType = this.generator.next();
    return type;
  }

  spawn(type) {
    const size = PIECES[type].size;
    this.piece = {
      type,
      rotation: 0,
      x: Math.floor((COLS - size) / 2),
      y: type === 'I' ? -1 : 0, // o I tem a linha de blocos no meio da matriz
    };
    this.dropTimer = 0;
    this.lockTimer = 0;
    this.lockResets = 0;

    // Sem espaço para a nova peça: fim de jogo.
    if (this.collides(this.piece)) this.endGame();
  }

  lockPiece() {
    let lockedAboveTop = false;
    for (const { x, y } of this.cellsOf(this.piece)) {
      if (y < 0) lockedAboveTop = true;
      else this.board[y][x] = this.piece.type;
    }
    this.piecesLocked++;
    const count = lockedAboveTop ? 0 : this.clearLines();
    if (count > 0) {
      this.score += LINE_SCORES[count] * this.level;
      this.lines += count;
      this.level = Math.floor(this.lines / LINES_PER_LEVEL) + 1;
      this.emit(GAME_EVENTS.LINES_CLEARED, { count });
    }

    // Emitido depois da limpeza: quem ouvir já vê o tabuleiro final.
    this.emit(GAME_EVENTS.PIECE_LOCKED, { type: this.piece.type, linesCleared: count });

    // Travou parte da peça fora do tabuleiro: fim de jogo.
    if (lockedAboveTop) {
      this.endGame();
      return;
    }

    this.canHold = true;
    this.spawn(this.takeNext());
  }

  // Remove as linhas completas e devolve quantas foram removidas.
  clearLines() {
    const remaining = this.board.filter((row) => row.some((cell) => cell === null));
    const count = ROWS - remaining.length;
    while (remaining.length < ROWS) remaining.unshift(Array(COLS).fill(null));
    this.board = remaining;
    return count;
  }

  endGame() {
    if (this.isOver) return;
    this.isOver = true;
    this.emit(GAME_EVENTS.GAME_OVER, { score: this.score, lines: this.lines });
  }
}
