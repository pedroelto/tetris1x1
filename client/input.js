// Controles de teclado no esquema "WASD" do Tetr.io, com handling próprio
// (DAS, ARR e SDF) em vez da repetição de tecla do sistema operacional.
//
// Usamos event.code (tecla física) para diferenciar o teclado numérico
// e para funcionar igual em qualquer layout (ABNT, US...).

import { gravityInterval } from '/shared/constants.js';

// Ajustes de handling (mesmos valores do Tetr.io do jogador).
const HANDLING = {
  DAS_MS: 167, // segurar ←/→ por este tempo antes de começar a deslizar
  ARR_MS: 27,  // depois do DAS, um passo a cada ARR ms (0 = vai direto até a parede)
  SDF: 33,     // soft drop é SDF vezes mais rápido que a gravidade
};

// Mapa: tecla física -> ação
const KEY_ACTIONS = {
  KeyA: 'left',          Numpad4: 'left',
  KeyD: 'right',         Numpad6: 'right',
  KeyW: 'softDrop',      Numpad8: 'softDrop',
  KeyS: 'hardDrop',      Numpad5: 'hardDrop',
  ArrowLeft: 'rotateCCW', Numpad7: 'rotateCCW',
  ArrowRight: 'rotateCW', Numpad9: 'rotateCW',
  ArrowUp: 'rotate180',   Numpad2: 'rotate180',
  ShiftLeft: 'hold', ShiftRight: 'hold', NumpadEnter: 'hold',
  Escape: 'forfeit',
  KeyR: 'retry',
};

// Ações pressionadas no momento (ex.: 'left', 'softDrop').
const held = new Set();

// Estado do movimento lateral automático.
let direction = 0;  // -1 esquerda, +1 direita, 0 parado
let dasTimer = 0;   // há quanto tempo a direção está pressionada
let arrTimer = 0;   // tempo acumulado desde o último passo automático
let softDropTimer = 0;

let getGame;

// getGame é uma função porque o jogo é recriado ao reiniciar;
// ela devolve null quando o jogador não pode jogar (menu, contagem, fim de partida).
export function setupInput(gameGetter, onRestart) {
  getGame = gameGetter;

  document.addEventListener('keydown', (event) => {
    const action = KEY_ACTIONS[event.code];
    const game = getGame();
    // Tecla não usada, ou nenhum jogo ativo (menu, contagem): deixa o navegador tratar.
    if (!action || !game) return;
    event.preventDefault(); // evita rolar a página com setas
    if (event.repeat) return; // repetição é feita por nós em updateInput()
    held.add(action);

    switch (action) {
      case 'left': startDirection(-1); break;
      case 'right': startDirection(1); break;
      case 'softDrop':
        softDropTimer = 0;
        game.softDrop();
        break;
      case 'hardDrop': game.hardDrop(); break;
      case 'rotateCCW': game.rotate(-1); break;
      case 'rotateCW': game.rotate(1); break;
      case 'rotate180': game.rotate(2); break;
      case 'hold': game.hold(); break;
      case 'forfeit': game.endGame(); break;
      case 'retry': onRestart(); break;
    }
  });

  document.addEventListener('keyup', (event) => {
    const action = KEY_ACTIONS[event.code];
    if (!action) return;
    held.delete(action);

    // Soltou a direção ativa: se a outra ainda estiver pressionada, volta para ela.
    if ((action === 'left' && direction === -1) || (action === 'right' && direction === 1)) {
      if (held.has('left')) startDirection(-1);
      else if (held.has('right')) startDirection(1);
      else direction = 0;
    }
  });

  // Se a janela perde o foco, o keyup não chega: solta tudo.
  window.addEventListener('blur', () => {
    held.clear();
    direction = 0;
  });
}

// Apertar uma direção move 1 casa na hora e reinicia a contagem do DAS.
function startDirection(dir) {
  direction = dir;
  dasTimer = 0;
  arrTimer = 0;
  getGame()?.move(dir);
}

// Chamado a cada frame pelo loop principal (dt em ms).
export function updateInput(dt) {
  const game = getGame();
  if (!game || game.isOver) return;

  // DAS + ARR: movimento lateral automático enquanto a tecla está segura.
  if (direction !== 0) {
    dasTimer += dt;
    if (dasTimer >= HANDLING.DAS_MS) {
      if (HANDLING.ARR_MS === 0) {
        while (game.move(direction)); // vai direto até a parede
      } else {
        arrTimer += dt;
        while (arrTimer >= HANDLING.ARR_MS) {
          arrTimer -= HANDLING.ARR_MS;
          game.move(direction);
        }
      }
    }
  }

  // SDF: enquanto o soft drop está seguro, desce SDF vezes mais rápido que a gravidade.
  if (held.has('softDrop')) {
    const interval = gravityInterval(game.level) / HANDLING.SDF;
    softDropTimer += dt;
    while (softDropTimer >= interval) {
      softDropTimer -= interval;
      game.softDrop();
    }
  }
}
