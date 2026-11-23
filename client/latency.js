// Simulador de latência (ferramenta de demonstração, fase 6).
// Módulo puro, sem DOM e sem rede: roda no navegador (client/net.js) e nos testes.
//
// schedule('out' | 'in', fn) executa fn depois de delayMs + aleatório(0..jitterMs).
//   - FIFO (padrão): uma mensagem nunca sai antes da anterior na mesma direção,
//     como no TCP. O jitter só "estica" a fila, não inverte a ordem.
//   - allowReorder: cada mensagem tem seu próprio atraso, então o jitter pode
//     inverter a ordem (como pacotes UDP). Serve para demonstrar o servidor
//     descartando mensagens fora de ordem pelo seq.

export function createLatencySimulator() {
  const settings = { delayMs: 0, jitterMs: 0, allowReorder: false };
  const queues = { out: [], in: [] }; // filas FIFO: [{ due, fn }] em ordem de saída

  function isActive() {
    return settings.delayMs > 0 || settings.jitterMs > 0;
  }

  function set({ delayMs = settings.delayMs, jitterMs = settings.jitterMs, allowReorder = settings.allowReorder }) {
    settings.delayMs = Math.max(0, Number(delayMs) || 0);
    settings.jitterMs = Math.max(0, Number(jitterMs) || 0);
    settings.allowReorder = Boolean(allowReorder);
  }

  function schedule(direction, fn) {
    const queue = queues[direction];
    // Sem latência e sem nada esperando na fila: entrega na hora.
    if (!isActive() && queue.length === 0) return fn();

    const delay = settings.delayMs + Math.random() * settings.jitterMs;
    if (settings.allowReorder) {
      setTimeout(fn, delay); // atraso independente: a ordem pode inverter
      return;
    }

    // FIFO: sai no instante sorteado, mas nunca antes da mensagem anterior.
    const previousDue = queue.length ? queue[queue.length - 1].due : 0;
    queue.push({ due: Math.max(performance.now() + delay, previousDue), fn });
    if (queue.length === 1) pump(direction);
  }

  // Entrega, em ordem, tudo o que já venceu; agenda a próxima verificação.
  function pump(direction) {
    const queue = queues[direction];
    while (queue.length && queue[0].due <= performance.now()) queue.shift().fn();
    if (queue.length) setTimeout(() => pump(direction), queue[0].due - performance.now());
  }

  return { settings, set, schedule, isActive };
}
