# Tetris 1v1 — Computação Distribuída

Tetris multiplayer 1v1 para a disciplina de Computação Distribuída. O foco
avaliado é a **sincronização cliente-servidor**: o servidor é a autoridade
sobre todos os eventos compartilhados entre os jogadores.

O projeto é construído em fases. Mantenha o código simples e legível (é
trabalho acadêmico e precisa ser explicado) e não implemente funcionalidades
de fases futuras antes da hora.

## Stack

- Node.js 20+, Express (arquivos estáticos), Socket.IO (a partir da fase 2)
- Cliente: JavaScript puro com ES modules + Canvas, sem framework e sem bundler
- `npm start` sobe o servidor e serve o cliente na mesma porta
  (`process.env.PORT`, padrão 3000)

## Estrutura

```
/server   servidor (Express + Socket.IO)
/tests    testes da engine e do protocolo
/docs     decisoes.md (decisões por fase), roteiro-demo.md, deploy.md
render.yaml  Blueprint do Render
/client   HTML, CSS, renderização (Canvas) e input
/shared   regras do jogo, constantes e nomes dos eventos do protocolo
          (importado pelo servidor via caminho relativo e pelo navegador via /shared/...)
```

Arquivos de `/shared`:

- `constants.js` — tamanho do tabuleiro, lock delay, pontuação, gravidade
- `pieces.js` — as 7 peças e as tabelas de wall kick do SRS
- `random.js` — PRNG `mulberry32` e gerador 7-bag (`PieceGenerator`)
- `emitter.js` — emissor de eventos mínimo
- `engine.js` — `TetrisGame`: engine pura (sem DOM, sem rede)
- `protocol.js` — nomes dos eventos de socket, estados da sala e constantes de rede
- `garbage.js` — tabela de ataque e `GARBAGE_DELAY_MS`
- `powerups.js` — tipos, tempos e motivos de recusa do power-up

Arquivos de `/server`: `index.js` (Express + Socket.IO), `rooms.js` (salas,
máquina de estados, seq, handlers, cálculo do ataque), `garbageQueue.js`
(fila de lixo e cancelamento), `powerups.js` (coordenador do power-up e
efeitos), `messaging.js` (send/broadcast com log; não envia a desconectados),
`config.js` (tempos sobrescrevíveis por variável de ambiente), `logger.js`
(log com timestamp do servidor; também alimenta o monitor), `monitor.js` +
`monitor.html` (monitor: autenticação, room "monitor", retrato das salas,
forçar power-up), `version.js` (versão do build).

Testes em `/tests`: `npm test` roda `engine.test.js`, `protocol.test.js`
(servidor na porta 3999), `reconnect.test.js` (porta 3998), `demo.test.js`
(porta 3997, com `MONITOR_KEY`) e `production.test.js` (portas 3994–3996,
`NODE_ENV=production`). Os testes de
rede sobem o próprio servidor com tempos curtos via variáveis de ambiente
(`POWERUP_*_MS`, `RECONNECT_TIMEOUT_MS`). Rodar após cada mudança; como
dependem de tempo, rodar mais de uma vez ao mexer em temporização.

Armadilha conhecida nos testes: eles usam `await` no topo do módulo antes de
`run()`, então `const`/`let` usados dentro de `run()` precisam ser declarados
ANTES dessa chamada (senão: "Cannot access X before initialization").

Arquivos de `/client`: `main.js` (telas e fluxo), `net.js` (socket, seq,
algoritmo de Cristian; ponto único da latência simulada), `render.js`,
`input.js` (WASD com DAS/ARR/SDF), `latency.js` (simulador de latência puro,
usado também pelos testes), `debug.js` (painel F2), `monitor.js` +
`monitor.css` (página do monitor).

Ferramentas de demonstração (monitor, painel F2) não podem alterar a lógica
do jogo nem do protocolo: só observam ou injetam falhas controladas.

Regra: nada em `/shared` pode depender de DOM ou de Node; precisa rodar nos dois.

Decisões técnicas e seus motivos ficam em `docs/decisoes.md` — atualizar a cada fase.

## Arquitetura

- **Simulação local:** cada cliente simula o próprio tabuleiro localmente,
  para que o input tenha resposta imediata (sem esperar ida e volta ao servidor).
- **Servidor autoritativo para o que é compartilhado:** tudo que afeta o
  adversário passa pelo servidor, que decide:
  - início da partida
  - semente das peças
  - fila de linhas de lixo (garbage)
  - power-ups disputados
  - fim de jogo
- **Mesma sequência de peças:** os dois jogadores recebem a mesma sequência,
  gerada a partir de uma semente distribuída pelo servidor (7-bag com PRNG
  determinístico `mulberry32`). Mesma semente ⇒ mesmas peças em qualquer máquina.
- **Engine orientada a eventos:** a engine não chama a rede. Ela emite eventos
  (`pieceLocked`, `linesCleared`, `gameOver`) e quem estiver ouvindo decide o
  que fazer — hoje a interface; depois, o módulo de socket.
- **Ordenação de mensagens:** toda mensagem do cliente terá número de sequência;
  o servidor processa em ordem de chegada e registra cada evento com timestamp
  próprio (o relógio do servidor é a referência).

## Fases

1. **Engine local (concluída):** Tetris single-player completo no navegador,
   semente gerada localmente, sem rede. Continua disponível como modo "Treino".
2. **Salas 1v1 (concluída):** conexão via Socket.IO, criação/entrada em sala,
   máquina de estados da sala, sincronização de relógio (Cristian), servidor
   inicia a partida e distribui a semente, tabuleiro enviado a cada peça travada,
   servidor decide o vencedor.
3. **Envio de linhas com cancelamento (concluída):** linhas limpas viram ataque
   calculado pelo servidor; o servidor mantém a fila de lixo de cada jogador
   (janela de 500 ms), cancela ataques recebidos com ataques enviados e manda
   aplicar o lixo pronto quando o jogador trava sem limpar.
4. **Power-up disputado (concluída):** exclusão mútua centralizada (algoritmo
   do coordenador). O servidor faz surgir o power-up, valida os pedidos em
   ordem de chegada, concede a um só e aplica os efeitos (escudo, dobro) no
   cálculo do ataque.
5. **Tolerância a falhas (concluída):** heartbeat curto detecta quedas; a partida
   fica "pausada" até 30 s esperando o jogador voltar (W.O. se não voltar);
   reconexão por `sessionToken` com `state_sync` (checkpoint + semente
   determinística reconstroem o jogo após F5; o cliente continua o `seq`).
6. **Ferramentas de demonstração (concluída):** monitor do servidor em
   `/monitor` (log ao vivo com destaque de conflitos, salas, forçar power-up;
   protegido por `MONITOR_KEY` ou só localhost) e painel de debug no cliente
   (F2: RTT/offset/seq, latência artificial FIFO ou com reordenação, simular
   queda). Não alteram a lógica do jogo. Roteiro em `docs/roteiro-demo.md`.
7. **Deploy no Render (concluída):** `render.yaml` (Blueprint, uma instância,
   plano free), `/health`, versão do build (`RENDER_GIT_COMMIT`) no menu e no
   monitor, `MONITOR_KEY` obrigatória em produção, monitor em modo compacto
   (`?compact=1`). Passo a passo e plano B (`cloudflared`) em `docs/deploy.md`.

## Produção (Render)

- Roda em **uma única instância**: o estado das salas fica em memória. Não
  adicionar réplicas sem antes tirar o estado da memória (ver decisoes.md).
- `NODE_ENV=production` ⇒ `npm ci` não instala devDependencies: nada em
  `/server`, `/shared` ou `/client` pode importar pacotes de teste.
- Sem `MONITOR_KEY` em produção o monitor fica desativado. Nunca usar
  cabeçalhos como `X-Forwarded-For` (forjáveis) para decisões de acesso;
  não ligar `trust proxy`.
- Um deploy reinicia o servidor e apaga as salas em andamento.

## Como rodar

```
npm install
npm start      # ou: npm run dev (reinicia o servidor ao mudar o código)
```

Abrir http://localhost:3000. Monitor: http://localhost:3000/monitor (local) ou
`/monitor?key=...` com `MONITOR_KEY` definida. Painel de debug: F2.
