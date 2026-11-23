# Roteiro de demonstração — Tetris 1v1

Cenário: o jogo roda **no Render**. Você joga no **seu notebook, projetado**;
o professor joga **no PC dele**, cada um numa máquina, pela internet.
Primeiro uma **partida x1 normal**; depois a **demonstração guiada** com o
monitor e o painel de debug.

Em cada passo: **o que fazer**, **o que aparece no monitor** e **qual
conceito da disciplina** está sendo mostrado.

(Para subir o serviço e o plano B com `cloudflared`, veja `docs/deploy.md`.)

---

## Preparação (uns 15 minutos antes)

1. **Acorde o serviço:** abra `https://SEU-SERVICO.onrender.com` e espere o
   menu carregar (o plano free dorme sem uso; a primeira visita pode demorar
   mais de 30 s).
2. **Confira a versão** no rodapé do menu (`versão abc1234`) e compare com o
   commit esperado (`git log --oneline -1`).
3. **Abra o monitor compacto ANTES de projetar** (a chave fica na URL):
   `https://SEU-SERVICO.onrender.com/monitor?key=SUA_CHAVE&compact=1`
4. **Arrume a tela** (1920×1080): janela do jogo na metade esquerda
   (Win + ←) e monitor na metade direita (Win + →). Na janela do jogo, use
   **zoom de 90%** (Ctrl + −), para o tabuleiro do adversário caber na meia tela.
5. **Mande o link do jogo para o professor** (só o do jogo, nunca o do monitor).
6. Confira que **não** há faixa laranja "Latência simulada" na sua aba
   (painel F2 zerado) e que nada será enviado para o GitHub durante a
   apresentação (um deploy reinicia o servidor e apaga as salas).

Legenda de cores no monitor: vermelho-escuro = disputa de power-up perdida,
azul = lixo cancelado, roxo = escudo, amarelo = descartado por `seq`,
vermelho = queda/pausa, verde = retomada.

---

## Parte 1 — Partida x1

**Fazer:** você clica em "Criar sala" e passa o código (5 letras) ao
professor; ele entra com o código. Os dois clicam em "Pronto" e jogam uma
partida normal até alguém perder. Sem painel de debug.

**No monitor (ao fundo, enquanto jogam):**
- a linha do topo mostra a sala, o estado (`jogando`) e o **RTT real** de cada
  jogador pela internet (o seu e o do professor costumam ser diferentes);
- a cada peça travada: `piece_locked` com `seq` crescente;
- ataques e cancelamentos destacados quando acontecem;
- no fim: `game_over` de quem perdeu e `match_end` enviado aos dois.

**Conceitos (comentário rápido):** servidor autoritativo; cada cliente simula
o próprio tabuleiro e o servidor decide o que é compartilhado (início,
semente, lixo, power-up, resultado); a contagem 3-2-1 termina junto nas duas
máquinas (relógio sincronizado).

Ao final, os dois clicam em **"Jogar de novo"** e **"Pronto"**: a parte 2
usa a mesma sala.

---

## Parte 2 — Demonstração guiada

### 2.1 Início sincronizado e mesma sequência de peças

**Fazer:** começar a partida (os dois "Pronto"). Clicar por um momento em
**"Modo completo"** no monitor, mostrar o `game_start` e voltar ao compacto.

**No monitor:** na sala, `contagem → jogando`; no modo completo, o
`game_start` enviado **aos dois** com a mesma `seed` e o mesmo `startAt`.

**Conceitos:**
- **Algoritmo de Cristian:** cada cliente mede RTT e offset com 5 pings e usa
  o de menor RTT. `startAt` é um horário absoluto **do servidor**; cada
  máquina converte com o próprio offset, e a contagem termina junto mesmo com
  latências diferentes.
- **Determinismo:** mesma semente ⇒ mesma sequência de peças (7-bag com PRNG
  `mulberry32`) nas duas máquinas, sem o servidor mandar peça por peça.

### 2.2 Envio e cancelamento de lixo

**Fazer:** pedir ao professor que limpe 2 ou mais linhas de uma vez. Mostrar
a barra vermelha enchendo à esquerda do seu tabuleiro (escura = a caminho,
forte = pronta após 500 ms). Antes de travar uma peça sem limpar, **limpe
linhas você também**.

**No monitor:**
- `ATAQUE … limpou=… ataque=… cancelou=… enviou=…` com as duas filas;
- o seu contra-ataque **em azul**, com `cancelou=N`;
- se o lixo entrar: `LIXO aplicado=[…]`.

**Conceitos:** estado compartilhado mantido pelo servidor (o cliente só diz
quantas linhas limpou; o servidor calcula e cancela); eventos concorrentes
resolvidos pela **ordem de chegada**; a janela de 500 ms garante que ataques
cruzados se compensem independentemente da ordem.

### 2.3 Disputa de power-up sem latência

**Preparar:** os dois deixam 2 linhas quase completas.

**Fazer:** no monitor, **"Forçar power-up"**. O ícone aparece nas duas telas
ao mesmo tempo. Os dois limpam as 2 linhas; quem limpar primeiro pega.

**No monitor:** `POWERUP … surgimento forçado pelo monitor`; um
`pedido … ACEITO` e, se os dois pediram, um `pedido … NEGADO: o adversário
pegou primeiro` **em vermelho**.

**Conceito:** **exclusão mútua centralizada (algoritmo do coordenador)**: o
servidor é o coordenador de um recurso único, atende os pedidos na ordem de
chegada e só um recebe. Verificar e conceder é atômico (um evento por vez no
Node, sem `await` no meio).

### 2.4 Disputa com 500 ms de latência na sua aba

**Fazer:** na **sua** aba, **F2** → Atraso = **500 ms** (aparece a faixa
laranja; feche o painel com F2). Mostrar no monitor que o seu RTT subiu
(~1000 ms a mais) e o offset continua perto do anterior. Preparar as 2 linhas
de novo, forçar o power-up e **limpar as linhas um pouco antes do professor**.

**Resultado esperado:** o professor ganha, mesmo você tendo limpado antes.

**No monitor:** o pedido do professor `ACEITO` e o seu `NEGADO: o adversário
pegou primeiro` **destacado em vermelho**, chegando depois (compare os
horários).

**Conceitos:**
- **A ordem de chegada não é a ordem real dos acontecimentos.** Sem relógio
  global, o coordenador só conhece a ordem em que **recebeu** as mensagens.
- **Cristian com RTT alto:** o RTT sobe, mas o offset continua correto (o erro
  da estimativa é limitado por RTT/2).

**Depois:** F2 → Atraso = 0 (a faixa laranja some).

### 2.5 Mensagem fora de ordem descartada

**Fazer:** na sua aba, F2 → **Atraso 100 ms, Jitter 300 ms, marcar "permitir
reordenação"**. Feche o painel e jogue rápido (vários hard drops seguidos com S).

**No monitor:** várias linhas `DESCARTADO … seq=N (seq repetido ou fora de
ordem; último=M)` **em amarelo**, com N < M. Seu tabuleiro na tela do
professor atualiza "aos saltos".

**Contraste:** desmarcar "permitir reordenação" (mantendo o jitter): os
descartes param — a fila FIFO atrasa, mas nunca inverte (como o TCP).

**Conceitos:** números de sequência detectam mensagens duplicadas ou fora de
ordem; canal FIFO × não-FIFO; com reordenação o filtro garante a ordem mas
**perde** mensagens, e por isso o protocolo depende de transporte ordenado
(TCP/WebSocket).

**Depois:** zerar atraso e jitter e desmarcar a reordenação.

### 2.6 Queda e retomada

**Fazer:** na sua aba, F2 → **"Simular queda"**. Esperar alguns segundos e
clicar em **"Reconectar"**.

**Nas telas:** o professor vê "Adversário desconectado, aguardando (Ns)"; você
vê "Conexão derrubada (simulação)". Na volta, contagem 3-2-1 nas duas máquinas.

**No monitor:**
- `disconnect (motivo: transport close)` **em vermelho**; a sala fica
  `pausada` com "W.O. em Ns" na linha do topo;
- se havia power-up ativo, ele é cancelado;
- ao voltar: `rejoin aceito` e `retomando…; readyAt do lixo adiado em …ms`
  **em verde**; a sala volta a `contagem → jogando`.

**Variação (F5):** recarregar a sua aba no meio da partida. O jogo volta com o
mesmo tabuleiro, hold e sequência de peças.

**Conceitos:** detecção de falhas por heartbeat/timeout (numa queda real de
rede o motivo seria `ping timeout`, em ~5 s); tolerância a falhas: pausar em
vez de punir, porque o servidor não distingue "lento" de "morto";
identidade de sessão (`sessionToken`) e recuperação de estado (`state_sync`
com checkpoint + gerador determinístico + continuação do `seq`); o lixo "a
caminho" não amadurece durante a pausa.

### 2.7 W.O. (por último: encerra a partida)

**Fazer:** F2 → "Simular queda" e **não** reconectar. Esperar o prazo (30 s,
ou 15 s se `RECONNECT_TIMEOUT_MS=15000` estiver configurado no Render).

**No monitor:** "W.O. em …" chegando a zero, `prazo de reconexão esgotado:
vitória por W.O.` **em vermelho**, `match_end` com `reason: "wo"`, sala
`encerrada`.

**Na tela do professor:** "Vitória! — Adversário não voltou a tempo (W.O.)".
Se você clicar "Reconectar", recebe "sessão inválida" e volta ao menu.

**Conceito:** timeout como **decisão sob incerteza**: depois do prazo, o
servidor *decide* que o processo falhou (detector de falhas com timeout).

---

## Ao terminar

- F2 na sua aba: atraso e jitter em 0, reordenação desmarcada, painel fechado.
- Feche a aba do monitor (a chave está na URL).
