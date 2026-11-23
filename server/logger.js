// Log de eventos do servidor. Cada linha tem o timestamp do SERVIDOR,
// que é a referência de tempo do sistema.
//
// Exemplo:
//   [14:03:22.481] RECEBIDO   P1 sala=K7QX2 seq=12 piece_locked
//   [14:03:22.482] ENVIADO    P2 sala=K7QX2        opponent_board
//   [14:03:22.900] DESCARTADO P1 sala=K7QX2 seq=11 piece_locked (seq repetido ou fora de ordem; último=12)
//
// Fase 6: além do console, cada evento vira uma entrada estruturada que vai
// para o monitor (/monitor) em tempo real e fica num histórico curto.

const HISTORY_SIZE = 500;
const history = [];
let sink = null; // função chamada a cada entrada (o monitor se registra aqui)

export function setLogSink(fn) {
  sink = fn;
}

export function getLogHistory() {
  return [...history];
}

function timestamp(now) {
  return `${now.toTimeString().slice(0, 8)}.${String(now.getMilliseconds()).padStart(3, '0')}`;
}

// Resume o payload para o log, sem despejar tabuleiros inteiros (inclusive os
// aninhados, como checkpoint.board no state_sync) e sem expor o sessionToken
// (o monitor pode estar projetado numa sala de aula).
function summarize(data) {
  if (!data) return '';
  const { seq, ...rest } = data;
  if (Object.keys(rest).length === 0) return '';
  return JSON.stringify(rest, (key, value) => {
    if ((key === 'board' || key === 'opponentBoard') && Array.isArray(value)) return '[tabuleiro]';
    if (key === 'sessionToken') return '[oculto]';
    return value;
  });
}

// Classifica eventos "de conflito" para o monitor destacá-los.
// Só lê o texto do log; não interfere na lógica do jogo.
function classify(kind, text) {
  if (kind === 'POWERUP' && text.includes('NEGADO') && text.includes('pegou primeiro')) return 'disputa';
  if (kind === 'POWERUP' && text.includes('ACEITO')) return 'powerup';
  if (text.includes('bloqueou')) return 'escudo';
  if (kind === 'ATAQUE' && /cancelou=[1-9]/.test(text)) return 'cancelamento';
  if (kind === 'DESCARTADO' && text.includes('seq')) return 'seq';
  if ((kind === 'CONEXAO' && text.includes('disconnect')) || text.includes('pausada') || text.includes('W.O.')) return 'queda';
  if (text.includes('rejoin aceito') || text.includes('retomando')) return 'retomada';
  return null;
}

// kind: 'RECEBIDO' | 'ENVIADO' | 'DESCARTADO' | 'NAO_ENVIADO' | 'SALA' | 'CONEXAO'
//       | 'SESSAO' | 'ATAQUE' | 'LIXO' | 'POWERUP'
export function logEvent(kind, player, eventName, data, note = '') {
  const now = new Date();
  const roomCode = player?.room?.code ?? null;
  const detail = summarize(data);
  const entry = {
    ts: now.getTime(),
    time: timestamp(now),
    kind,
    playerId: player?.id ?? null,
    room: roomCode,
    seq: data?.seq ?? null,
    event: eventName,
    detail,
    note,
    tag: classify(kind, `${eventName} ${note}`),
  };

  const parts = [
    `[${entry.time}]`,
    kind.padEnd(10),
    (entry.playerId ?? '--').padEnd(4),
    `sala=${roomCode ?? '-----'}`,
    (entry.seq !== null ? `seq=${entry.seq}` : '').padEnd(7),
    eventName,
    detail,
    note && `(${note})`,
  ];
  console.log(parts.filter(Boolean).join(' '));

  history.push(entry);
  if (history.length > HISTORY_SIZE) history.shift();
  sink?.(entry);
}
