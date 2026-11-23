// Protocolo de comunicação cliente <-> servidor (Socket.IO).
// Fica em /shared para que os dois lados usem exatamente as mesmas strings.
//
// Regra: TODA mensagem cliente -> servidor leva um campo `seq` (inteiro
// crescente por cliente). O servidor descarta seq repetido ou fora de ordem.

// Cliente -> servidor
export const CLIENT_EVENTS = {
  TIME_PING: 'time_ping',       // { seq, clientTime }          sincronização de relógio
  CREATE_ROOM: 'create_room',   // { seq, nickname }
  JOIN_ROOM: 'join_room',       // { seq, nickname, code }
  PLAYER_READY: 'player_ready', // { seq }
  PIECE_LOCKED: 'piece_locked', // { seq, board, linesCleared } tabuleiro após travar uma peça
  GAME_OVER: 'game_over',       // { seq }
  PLAY_AGAIN: 'play_again',     // { seq }                      volta a sala para "aguardando"
  POWERUP_CLAIM: 'powerup_claim', // { seq, powerupId }         pedido do recurso (enviado logo após o piece_locked)
  REJOIN: 'rejoin',             // { seq, sessionToken, code }  volta para a partida após queda/F5 (1ª mensagem)
  CLOCK_REPORT: 'clock_report', // { seq, rtt, offset }         só informativo, exibido no monitor (fase 6)
};

// Servidor -> cliente
export const SERVER_EVENTS = {
  TIME_PONG: 'time_pong',           // { clientTime, serverTime }
  ROOM_JOINED: 'room_joined',       // { code, playerId, sessionToken }  resposta a create/join
  ROOM_ERROR: 'room_error',         // { message }               sala cheia, inexistente...
  ROOM_UPDATE: 'room_update',       // { code, state, players: [{ id, nickname, ready }] }
  GAME_START: 'game_start',         // { seed, startAt }         startAt no relógio do servidor
  OPPONENT_BOARD: 'opponent_board', // { board }
  MATCH_END: 'match_end',           // { winner, winnerNickname, reason }
  ATTACK_RESULT: 'attack_result',   // { attack, cancelled, sent, blocked }  resultado do meu ataque
  GARBAGE_QUEUE: 'garbage_queue',   // { pending, ready, entries: [{ lines, readyAt }] }  minha fila
  GARBAGE_APPLY: 'garbage_apply',   // { entries: [{ lines, holeCol }] }  inserir lixo agora
  POWERUP_SPAWN: 'powerup_spawn',       // { id, type, expiresAt }   expiresAt no relógio do servidor
  POWERUP_EXPIRED: 'powerup_expired',   // { id }
  POWERUP_GRANTED: 'powerup_granted',   // { id, type }        para quem ganhou a disputa
  POWERUP_TAKEN: 'powerup_taken',       // { id, byNickname }  para o outro
  POWERUP_DENIED: 'powerup_denied',     // { id, reason }      para quem pediu e não levou
  POWERUP_CONSUMED: 'powerup_consumed', // { type, detail }    meu efeito foi usado
  REJOIN_FAILED: 'rejoin_failed',       // { reason }          token inválido, de outra sala ou partida encerrada
  STATE_SYNC: 'state_sync',             // estado para retomar: seed, checkpoint, tabuleiro do adversário,
                                        // fila de lixo, efeito, estado da sala, lastSeq...
  MATCH_PAUSED: 'match_paused',         // { reason, deadline }  deadline no relógio do servidor
  MATCH_RESUME: 'match_resume',         // { resumeAt }          contagem 3-2-1 até resumeAt
};

// Estados da sala. Só o servidor muda o estado.
//   aguardando -> pronta -> contagem -> jogando -> encerrada -> aguardando ...
//                                       jogando -> pausada -> contagem -> jogando   (queda e volta)
//                                                  pausada -> encerrada              (W.O.)
export const ROOM_STATES = {
  WAITING: 'aguardando', // menos de 2 jogadores
  READY: 'pronta',       // 2 jogadores, esperando os dois clicarem "Pronto"
  COUNTDOWN: 'contagem', // contagem 3-2-1 rodando (início ou retomada)
  PLAYING: 'jogando',
  PAUSED: 'pausada',     // um jogador caiu; aguardando ele voltar até o prazo
  ENDED: 'encerrada',    // resultado enviado; aguardando "Jogar de novo"
};

export const MAX_PLAYERS = 2;
export const COUNTDOWN_MS = 3000;
export const CLOCK_SYNC_SAMPLES = 5;

// Detecção de falha (heartbeat do Socket.IO): o servidor manda um ping a cada
// HEARTBEAT_INTERVAL_MS; se a resposta não vier em HEARTBEAT_TIMEOUT_MS, a
// conexão é considerada morta. Pior caso para detectar uma queda: ~5 s.
export const HEARTBEAT_INTERVAL_MS = 2000;
export const HEARTBEAT_TIMEOUT_MS = 3000;

// Prazo para o jogador que caiu voltar antes de perder por W.O.
export const RECONNECT_TIMEOUT_MS = 30000;

// ---------- Monitor do servidor (fase 6) ----------
// O monitor é uma ferramenta de demonstração; não participa do jogo.
// Ele se conecta com auth { role: 'monitor', key } e entra na room MONITOR_ROOM.

export const MONITOR_ROOM = 'monitor';

export const MONITOR_EVENTS = {
  HISTORY: 'monitor_history',             // servidor -> monitor: [entradas de log] recentes
  LOG: 'monitor_log',                     // servidor -> monitor: uma entrada de log, em tempo real
  ROOMS: 'monitor_rooms',                 // servidor -> monitor: retrato das salas (periódico)
  ERROR: 'monitor_error',                 // servidor -> monitor: { reason } acesso negado
  FORCE_POWERUP: 'monitor_force_powerup', // monitor -> servidor: { code }
  FORCE_RESULT: 'monitor_force_result',   // servidor -> monitor: { code, ok, message }
};

// De quanto em quanto tempo o cliente informa RTT/offset ao servidor (para o monitor).
export const CLOCK_REPORT_INTERVAL_MS = 5000;
