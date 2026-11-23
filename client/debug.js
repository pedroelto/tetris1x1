// Painel de debug (F2): ferramenta de demonstração, não faz parte do jogo.
// Mostra RTT, offset, último seq e estado da sala; controla a latência
// artificial desta aba e permite simular uma queda de conexão.

import * as net from './net.js';

const $ = (id) => document.getElementById(id);

export function setupDebugPanel({ getRoomState, onLatencyChanged }) {
  const panel = $('debug-panel');

  // F2 abre/fecha. Nenhuma outra tecla é tratada aqui, então com o painel
  // fechado ele não interfere nos controles do jogo.
  document.addEventListener('keydown', (event) => {
    if (event.code !== 'F2') return;
    event.preventDefault();
    panel.hidden = !panel.hidden;
    // Ao fechar, tira o foco de qualquer controle do painel (um slider com
    // foco responderia às setas, um botão ao Enter).
    if (panel.hidden && panel.contains(document.activeElement)) document.activeElement.blur();
    refresh();
  });

  // ---------- Latência ----------

  let resyncTimer = null;
  function applyLatency() {
    net.setLatency({
      delayMs: Number($('dbg-delay').value),
      jitterMs: Number($('dbg-jitter').value),
      allowReorder: $('dbg-reorder').checked,
    });
    updateLatencyLabels();
    // RTT e offset têm de refletir a nova latência: refaz a sincronização
    // (com um pequeno atraso, para não disparar a cada passo do slider).
    clearTimeout(resyncTimer);
    resyncTimer = setTimeout(onLatencyChanged, 300);
  }

  function updateLatencyLabels() {
    const { delayMs, jitterMs, allowReorder } = net.latencySettings;
    $('dbg-delay-value').textContent = `${delayMs} ms`;
    $('dbg-jitter-value').textContent = `${jitterMs} ms`;
    const badge = $('latency-badge');
    badge.hidden = delayMs === 0 && jitterMs === 0;
    badge.textContent = `⚠ Latência simulada: ${delayMs} ms ± ${jitterMs} ms` +
      (allowReorder ? ' (com reordenação)' : '');
  }

  $('dbg-delay').addEventListener('input', applyLatency);
  $('dbg-jitter').addEventListener('input', applyLatency);
  $('dbg-reorder').addEventListener('change', applyLatency);

  // ---------- Queda simulada ----------

  $('dbg-drop').addEventListener('click', (event) => {
    event.currentTarget.blur();
    net.simulateDrop();
    refresh();
  });
  $('dbg-reconnect').addEventListener('click', (event) => {
    event.currentTarget.blur();
    net.reconnect();
    refresh();
  });

  // ---------- Estatísticas ----------

  function refresh() {
    if (panel.hidden) return;
    const { rtt, offset } = net.clock;
    $('dbg-rtt').textContent = rtt === null ? '—' : `${rtt} ms`;
    $('dbg-offset').textContent = `${offset >= 0 ? '+' : ''}${offset.toFixed(1)} ms`;
    $('dbg-seq').textContent = net.lastSentSeq();
    $('dbg-room').textContent = getRoomState() ?? '—';
    $('dbg-connection').textContent = net.isConnected()
      ? 'conectado'
      : (net.isDropSimulated() ? 'queda simulada' : 'desconectado');
    $('dbg-drop').disabled = !net.isConnected();
    $('dbg-reconnect').disabled = net.isConnected();
  }

  setInterval(refresh, 250);
  updateLatencyLabels();
}
