// Monitor do servidor: recebe o log em tempo real e o retrato das salas.
// A chave vem da URL (/monitor?key=...) e vai no handshake do Socket.IO.

import { MONITOR_EVENTS as M } from '/shared/protocol.js';

const $ = (id) => document.getElementById(id);
const MAX_ROWS = 400;
const CLOCK_EVENTS = ['time_ping', 'time_pong', 'clock_report'];

const params = new URLSearchParams(location.search);
const key = params.get('key') ?? '';
const socket = io({ auth: { role: 'monitor', key } });

let entries = []; // log recebido (mais antigo primeiro)
let rooms = [];
let currentRoom = null; // sala do evento mais recente (para o filtro "sala atual")

// Versão do build no ar (hash do commit no Render, "dev" local).
fetch('/version')
  .then((res) => res.json())
  .then(({ version }) => { $('version').textContent = `versão ${version}`; })
  .catch(() => {});

// ---------- Modo compacto (meia tela 1920x1080, ao lado do jogo) ----------
// Só a timeline da sala atual, com os destaques de conflito.
// Ativado por ?compact=1 na URL ou pelo botão.

function setCompact(on) {
  document.body.classList.toggle('compact', on);
  $('toggle-compact').textContent = on ? 'Modo completo' : 'Modo compacto';
  if (on && $('room-filter').value === '') $('room-filter').value = '__auto';
  // Guarda na URL, para um F5 manter o modo.
  if (on) params.set('compact', '1');
  else params.delete('compact');
  history.replaceState(null, '', `${location.pathname}?${params}`);
  renderTimeline();
  renderCompactRoom();
}

$('toggle-compact').addEventListener('click', () => setCompact(!document.body.classList.contains('compact')));

function renderCompactRoom() {
  const el = $('compact-room');
  const room = rooms.find((r) => r.code === selectedRoom());
  if (!room) {
    el.textContent = 'aguardando uma sala...';
    return;
  }
  const players = room.players
    .map((p) => `${p.nickname}${p.connected ? '' : ' (OFFLINE)'}${p.rtt === null ? '' : ` ${Math.round(p.rtt)} ms`}`)
    .join(' × ');
  el.replaceChildren(`Sala ${room.code} · `);
  const state = document.createElement('span');
  state.className = `state state-${room.state}`;
  state.textContent = room.state;
  el.append(state, ` · ${players}`);
  if (room.reconnectDeadline) {
    const wait = countdownSpan(' · W.O. em ', room.reconnectDeadline);
    wait.className = 'offline';
    el.append(wait);
  }
  el.append(' ', forceButton(room));
}

// Botão "Forçar power-up" + espaço para a resposta do servidor.
function forceButton(room, previousResult) {
  const wrapper = document.createElement('span');
  const button = document.createElement('button');
  button.textContent = 'Forçar power-up';
  button.disabled = room.state !== 'jogando';
  button.addEventListener('click', () => socket.emit(M.FORCE_POWERUP, { code: room.code }));
  const result = document.createElement('span');
  result.dataset.result = room.code;
  result.textContent = previousResult?.text ?? '';
  result.style.color = previousResult?.color ?? '';
  wrapper.append(button, ' ', result);
  return wrapper;
}

// ---------- Conexão ----------

function setStatus(text, cls) {
  $('status').textContent = text;
  $('status').className = `status ${cls}`;
}

socket.on('connect', () => setStatus('conectado', 'ok'));
socket.on('disconnect', () => setStatus('desconectado', 'error'));
socket.on(M.ERROR, ({ reason }) => setStatus(`acesso negado: ${reason}`, 'error'));

socket.on(M.HISTORY, (history) => {
  entries = history;
  currentRoom = [...history].reverse().find((e) => e.room)?.room ?? null;
  renderTimeline();
});

socket.on(M.LOG, (entry) => {
  entries.push(entry);
  if (entries.length > MAX_ROWS * 2) entries = entries.slice(-MAX_ROWS);
  // "Sala atual" segue a sala do evento mais recente.
  if (entry.room && entry.room !== currentRoom) {
    currentRoom = entry.room;
    if ($('room-filter').value === '__auto') {
      renderTimeline();
      renderCompactRoom();
      return;
    }
  }
  if (isVisible(entry)) prependRow(entry);
});

// Só redesenha quando o retrato muda: recriar os botões a cada 500 ms
// faria um clique "cair no vazio". As contagens regressivas são atualizadas à parte.
let lastSnapshotJson = '';
socket.on(M.ROOMS, (snapshot) => {
  const json = JSON.stringify(snapshot);
  if (json === lastSnapshotJson) return;
  lastSnapshotJson = json;
  rooms = snapshot;
  renderRooms();
  updateRoomFilter();
  renderCompactRoom();
});

// Elementos com data-until (timestamp do servidor) mostram "N s" restantes.
function countdownSpan(prefix, until) {
  const span = document.createElement('span');
  span.dataset.until = until;
  span.dataset.prefix = prefix;
  updateCountdown(span);
  return span;
}

function updateCountdown(span) {
  const secs = Math.max(0, Math.ceil((Number(span.dataset.until) - Date.now()) / 1000));
  span.textContent = `${span.dataset.prefix}${secs}s `;
}

setInterval(() => document.querySelectorAll('[data-until]').forEach(updateCountdown), 250);

socket.on(M.FORCE_RESULT, ({ code, ok, message }) => {
  for (const el of document.querySelectorAll(`[data-result="${code}"]`)) {
    el.textContent = message;
    el.style.color = ok ? '#4cff7a' : '#ff6b6b';
  }
});

// ---------- Timeline ----------

// Sala escolhida no filtro ('__auto' = a sala do evento mais recente).
function selectedRoom() {
  const value = $('room-filter').value;
  return value === '__auto' ? currentRoom : value || null;
}

function isVisible(entry) {
  const roomFilter = selectedRoom();
  if (roomFilter && entry.room !== roomFilter) return false;
  if ($('hide-clock').checked && CLOCK_EVENTS.includes(entry.event)) return false;
  if ($('only-conflicts').checked && !entry.tag) return false;
  return true;
}

function makeRow(entry) {
  const li = document.createElement('li');
  if (entry.tag) li.className = `tag-${entry.tag}`;
  const span = (cls, text) => {
    const s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    return s;
  };
  li.append(
    span('time', entry.time), ' ',
    span('kind', entry.kind.padEnd(10)), ' ',
    `${(entry.playerId ?? '--').padEnd(4)} `,
    span('room', `${entry.room ?? '-----'} `),
    span('seq', entry.seq !== null ? `seq=${entry.seq} ` : ''),
    entry.event,
    span('detail', entry.detail ? ` ${entry.detail}` : ''),
    entry.note ? ` (${entry.note})` : '',
  );
  return li;
}

function prependRow(entry) {
  const list = $('timeline');
  list.prepend(makeRow(entry));
  while (list.children.length > MAX_ROWS) list.lastChild.remove();
}

function renderTimeline() {
  const visible = entries.filter(isVisible).slice(-MAX_ROWS).reverse();
  $('timeline').replaceChildren(...visible.map(makeRow));
}

for (const id of ['room-filter', 'hide-clock', 'only-conflicts']) {
  $(id).addEventListener('change', () => {
    renderTimeline();
    renderCompactRoom();
  });
}
$('clear-log').addEventListener('click', () => {
  entries = [];
  renderTimeline();
});

function updateRoomFilter() {
  const select = $('room-filter');
  const known = new Set([...select.options].map((o) => o.value));
  for (const room of rooms) {
    if (!known.has(room.code)) select.add(new Option(room.code, room.code));
  }
}

// ---------- Salas ----------

function fmt(value, digits = 0) {
  return value === null || value === undefined ? '—' : Number(value).toFixed(digits);
}

function renderRooms() {
  const container = $('rooms');
  if (rooms.length === 0) {
    container.innerHTML = '<p class="muted">nenhuma sala</p>';
    return;
  }
  // Guarda as mensagens do botão de forçar para não sumirem a cada atualização.
  const results = {};
  for (const el of container.querySelectorAll('[data-result]')) {
    results[el.dataset.result] = { text: el.textContent, color: el.style.color };
  }
  container.replaceChildren(...rooms.map((room) => renderRoom(room, results[room.code])));
}

function renderRoom(room, previousResult) {
  const div = document.createElement('div');
  div.className = 'room';

  const head = document.createElement('div');
  head.className = 'room-head';
  const code = document.createElement('span');
  code.className = 'room-code';
  code.textContent = room.code;
  const state = document.createElement('span');
  state.className = `state state-${room.state}`;
  state.textContent = room.state;
  head.append(code, state);
  if (room.reconnectDeadline) {
    const wait = countdownSpan('W.O. em ', room.reconnectDeadline);
    wait.className = 'offline';
    head.append(wait);
  }

  const table = document.createElement('table');
  table.innerHTML = '<tr><th>Jogador</th><th>RTT</th><th>Offset</th><th>Lixo (pronto)</th><th>Efeito</th><th>seq</th></tr>';
  for (const p of room.players) {
    const tr = table.insertRow();
    const name = tr.insertCell();
    name.textContent = `${p.nickname} (${p.id})`;
    if (!p.connected) {
      const off = document.createElement('span');
      off.className = 'offline';
      off.textContent = ' OFFLINE';
      name.append(off);
    }
    tr.insertCell().textContent = p.rtt === null ? '—' : `${fmt(p.rtt)} ms`;
    tr.insertCell().textContent = p.offset === null ? '—' : `${fmt(p.offset, 1)} ms`;
    tr.insertCell().textContent = `${p.garbagePending} (${p.garbageReady})`;
    tr.insertCell().textContent = p.effect ?? '—';
    tr.insertCell().textContent = p.lastSeq;
  }

  const powerup = document.createElement('div');
  powerup.className = 'room-powerup';
  const pu = room.powerup;
  let info;
  if (pu && !pu.grantedTo) {
    info = countdownSpan(`Power-up: ${pu.id} (${pu.type}) ativo, expira em `, pu.expiresAt);
  } else {
    info = document.createElement('span');
    info.textContent = pu ? `Power-up: ${pu.id} (${pu.type}) ficou com ${pu.grantedTo} ` : 'Power-up: nenhum ativo ';
  }
  powerup.append(info, forceButton(room, previousResult));

  div.append(head, table, powerup);
  return div;
}

// Abre em modo compacto se a URL pedir (?compact=1).
setCompact(params.get('compact') === '1');
