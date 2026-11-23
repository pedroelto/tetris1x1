// Geração determinística de peças.
// Com a mesma semente, qualquer máquina gera exatamente a mesma sequência —
// é isso que vai permitir que os dois jogadores recebam as mesmas peças
// a partir de uma semente distribuída pelo servidor.

import { PIECE_TYPES } from './pieces.js';

// mulberry32: PRNG simples de 32 bits. Retorna uma função que devolve
// números em [0, 1), sempre na mesma ordem para a mesma semente.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Gera uma semente aleatória de 32 bits (nesta fase, usada localmente;
// nas próximas fases quem gera é o servidor).
export function randomSeed() {
  return Math.floor(Math.random() * 4294967296);
}

// Gerador "7-bag": embaralha as 7 peças, entrega uma a uma e, quando o
// saco esvazia, embaralha de novo. Garante que nunca falte uma peça por muito tempo.
export class PieceGenerator {
  constructor(seed) {
    this.random = mulberry32(seed);
    this.bag = [];
  }

  next() {
    if (this.bag.length === 0) this.refill();
    return this.bag.shift();
  }

  refill() {
    const bag = [...PIECE_TYPES];
    // Embaralhamento Fisher-Yates usando o PRNG determinístico.
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    this.bag = bag;
  }
}
