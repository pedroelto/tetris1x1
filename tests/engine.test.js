// Testes da engine (sem rede): node tests/engine.test.js

import { TetrisGame, GAME_EVENTS, pushGarbage, createBoard } from '../shared/engine.js';
import { PieceGenerator } from '../shared/random.js';
import { attackFor } from '../shared/garbage.js';
import { check, section, finish } from './helpers.js';

section('Gerador de peças');
const a = new PieceGenerator(42);
const b = new PieceGenerator(42);
const seqA = Array.from({ length: 14 }, () => a.next()).join('');
const seqB = Array.from({ length: 14 }, () => b.next()).join('');
check('mesma semente => mesma sequência', seqA === seqB);
check('cada saco tem as 7 peças', new Set(seqA.slice(0, 7)).size === 7);

section('Limpeza de linha e eventos');
const game = new TetrisGame(123);
const events = [];
game.on(GAME_EVENTS.PIECE_LOCKED, (e) => events.push(e));
for (let x = 1; x < 10; x++) game.board[19][x] = 'G';
game.piece = { type: 'I', rotation: 1, x: -2, y: 0 }; // I em pé na coluna 0
game.hardDrop();
check('limpou 1 linha', game.lines === 1);
check('pieceLocked informa linesCleared', events[0]?.linesCleared === 1);
check('tabuleiro sem linha completa depois', !game.board.some((r) => r.every((c) => c !== null)));

section('Lixo');
const g2 = new TetrisGame(1);
g2.addGarbage(3, 4);
const bottom = g2.board[19].map((c) => (c ? '#' : '.')).join('');
check('linha de lixo com buraco na coluna 4', bottom === '####.#####');
check('3 linhas de lixo', g2.board.slice(17).every((r) => r[4] === null && r[0] === 'G'));
let over = false;
g2.on(GAME_EVENTS.GAME_OVER, () => { over = true; });
g2.addGarbage(20, 0);
check('lixo sem espaço => game over', over);
const pushed = pushGarbage(createBoard(), 2, 7);
check('pushGarbage (usada pelo servidor no checkpoint) não altera o original',
  pushed.board[19][7] === null && pushed.board[19][0] === 'G' && !pushed.overflow);

section('Reconstrução a partir do checkpoint (F5)');
// Joga com hard drops, movimentos e holds aleatórios; depois de cada peça
// travada, reconstrói o jogo pelo checkpoint e compara com o original.
let mismatches = 0;
let checked = 0;
for (let seed = 1; seed <= 20; seed++) {
  const original = new TetrisGame(seed);
  let checkpoint = null;
  original.on(GAME_EVENTS.PIECE_LOCKED, () => {
    checkpoint = {
      board: original.board.map((r) => [...r]),
      hold: original.holdType,
      piecesLocked: original.piecesLocked,
      score: original.score,
      lines: original.lines,
    };
  });
  let rnd = seed;
  const random = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 60 && !original.isOver; i++) {
    if (random() < 0.3) original.hold();
    original.move(Math.floor(random() * 9) - 4);
    original.hardDrop();
    if (original.isOver) break;
    const restored = TetrisGame.fromCheckpoint(seed, checkpoint);
    checked++;
    const same = restored.piece.type === original.piece.type &&
      restored.nextType === original.nextType &&
      restored.holdType === original.holdType &&
      restored.score === original.score &&
      JSON.stringify(restored.board) === JSON.stringify(original.board);
    if (!same) mismatches++;
  }
}
check(`peça atual, próxima, hold, pontos e tabuleiro iguais (${checked} checkpoints)`, mismatches === 0);

section('Tabela de ataque');
check('1→0, 2→1, 3→2, 4→4', [1, 2, 3, 4].map(attackFor).join() === '0,1,2,4');

process.exit(finish());
