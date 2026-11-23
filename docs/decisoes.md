# Decisões técnicas

Registro das decisões do projeto e do porquê de cada uma. Base para o relatório.

## Fase 1 — Engine local

- **Engine pura em `/shared`, sem DOM e sem rede.** A mesma lógica roda no
  navegador e no Node; o servidor pode importar as regras se precisar validar algo.
- **Engine emite eventos (`pieceLocked`, `linesCleared`, `gameOver`) em vez de
  chamar a rede.** Desacopla a regra do jogo do transporte: na fase 2 bastou
  "ouvir" esses eventos e enviá-los pelo socket, sem mexer na engine.
- **Gerador 7-bag com PRNG determinístico (`mulberry32`).** `Math.random()` não
  aceita semente; com `mulberry32`, a mesma semente produz a mesma sequência
  em qualquer máquina. É a base para os dois jogadores terem as mesmas peças.

## Fase 2 — Salas 1v1

### Protocolo
- **Nomes de eventos centralizados em `shared/protocol.js`.** Cliente e
  servidor importam as mesmas constantes, evitando erro de digitação em strings.
- **Número de sequência (`seq`) em toda mensagem cliente → servidor.** Cada
  cliente incrementa seu contador; o servidor guarda o último `seq` aceito de
  cada jogador e **descarta** mensagens com `seq` repetido ou menor (duplicadas
  ou fora de ordem), registrando o descarte no log. O TCP/Socket.IO já entrega
  em ordem numa mesma conexão, mas o mecanismo deixa a regra explícita e será
  exercitado pelo simulador de latência (fase 6).
- **Log no servidor com timestamp do próprio servidor**, jogador, sala e `seq`,
  para cada evento recebido, enviado ou descartado. O relógio do servidor é a
  referência única de tempo do sistema.

### Salas
- **Estado em memória (`Map` código → sala), sem banco.** Partidas são curtas
  e não precisam sobreviver a um reinício do servidor; simplifica o código.
- **Código de 5 caracteres** sem caracteres ambíguos (sem `0/O`, `1/I`), para
  ser fácil de ditar ao adversário.
- **Máquina de estados controlada só pelo servidor:**
  `aguardando → pronta → contagem → jogando → encerrada → (jogar de novo) → aguardando`.
  O cliente nunca muda o estado; ele só *pede* (pronto, jogar de novo) e
  recebe `room_update`. Eventos que chegam no estado errado são descartados
  (ex.: `piece_locked` fora de `jogando`).
- **Semente gerada pelo servidor** quando os dois estão prontos, e enviada aos
  dois no mesmo `game_start`.

### Sincronização de relógio (algoritmo de Cristian)
- O cliente faz **5 pings**; para cada um calcula
  `RTT = t1 - t0` e `offset = horaServidor + RTT/2 - t1`, e usa o **offset do
  ping de menor RTT**. Menor RTT = menor incerteza: o erro máximo da estimativa
  é ±RTT/2, então o ping mais rápido dá a melhor estimativa.
- **`game_start` traz `startAt` no relógio do servidor** (agora + 3 s), não
  "comece em 3 segundos". Se fosse relativo, cada cliente começaria a contar
  quando a mensagem chegasse, e quem tem mais latência começaria atrasado.
  Com o horário absoluto convertido pelo offset, as duas contagens terminam
  no mesmo instante (dentro do erro da estimativa).
- RTT e offset aparecem no canto da tela para a apresentação.

### Durante a partida
- **Cada cliente simula o próprio tabuleiro** (resposta imediata ao input).
- **O tabuleiro é enviado só quando uma peça trava (`piece_locked`), não a
  cada frame.** Reduz o tráfego de ~60 mensagens/s para uma a cada peça
  (~1 por segundo). O adversário não vê a peça caindo, só o resultado — o que
  é suficiente para acompanhar o jogo.
- O evento `pieceLocked` da engine passou a ser emitido **depois** da limpeza
  de linhas, para o tabuleiro enviado já estar sem as linhas completas.
- **O servidor valida** que o jogador está numa sala em `jogando` e que o
  tabuleiro tem formato 20×10 antes de repassar.
- **Resultado decidido pelo servidor:** o primeiro `game_over` que chega perde.
  Se os dois perderem quase juntos, a ordem de chegada no servidor desempata;
  o segundo `game_over` chega com a sala já `encerrada` e é descartado. Os dois
  recebem o mesmo `match_end`, então nunca há resultados divergentes.

### Desconexão (versão simples)
- Se um jogador cai durante `contagem` ou `jogando`, o outro vence e recebe
  `match_end` com o motivo. No lobby, a sala só volta para `aguardando`.
  Sala vazia é removida. Reconexão fica para a fase 5.

### Desenvolvimento
- `npm run dev` usa `node --watch` (nativo do Node 20), sem dependência extra
  como nodemon.

## Fase 3 — Linhas de lixo

### Quem calcula o ataque: o servidor
- `piece_locked` agora leva `linesCleared`, mas **o cliente nunca diz quanto
  lixo mandar**. O servidor converte linhas limpas em ataque com a tabela de
  `shared/garbage.js` (1→0, 2→1, 3→2, 4→4).
- Por quê: o ataque afeta o *outro* jogador, então é estado compartilhado e,
  pela nossa arquitetura, quem decide é o servidor. Se o cliente mandasse
  "ataque = 10", um cliente modificado poderia trapacear; assim ele só pode
  mentir sobre quantas linhas limpou, e isso é limitado e validado.
- Validações (mensagem inválida é descartada e registrada no log):
  `linesCleared` inteiro entre 0 e 4, tabuleiro 20×10, e **nenhuma linha
  completa** no tabuleiro recebido (a engine sempre remove linhas completas
  antes de emitir o evento, então um tabuleiro com linha cheia é incoerente).
- A tabela fica num array, separada da lógica, para estender depois
  (combo, back-to-back, T-spin) trocando apenas `attackFor()`.

### Fila de lixo no servidor
- Cada jogador tem no servidor uma fila de entradas
  `{ lines, holeCol, readyAt }`, em ordem de chegada. O cliente só recebe
  cópias (`garbage_queue`) para desenhar a barra.
- **Cancelamento:** quando A ataca com valor X, X primeiro abate a fila
  pendente do próprio A, das entradas mais antigas para as mais novas
  (prontas ou não). Só o que sobra vai para a fila de B. É a mecânica de
  "defesa" do Tetris competitivo: limpar linhas enquanto há lixo chegando
  anula esse lixo em vez de mandar ataque.
- **Buraco sorteado pelo servidor**, um por ataque (todas as linhas do mesmo
  ataque têm o buraco na mesma coluna). Sorteado no servidor para o cliente
  não poder escolher um buraco conveniente.

### Por que a janela de 500 ms (`GARBAGE_DELAY_MS`)
- Cada ataque entra na fila com `readyAt = agora + 500 ms`. Antes disso ele
  não pode entrar no tabuleiro, só ser cancelado.
- Motivos:
  1. **Chance de defesa.** Sem a janela, o lixo entraria na próxima peça
     travada, às vezes poucos milissegundos depois do ataque, e o jogador
     não teria tempo nem de ver a barra encher.
  2. **Compensa a latência.** Um jogador com mais latência veria o ataque
     chegar "atrasado" e teria menos tempo para reagir; a janela dá a todos
     um tempo mínimo de reação, medido no relógio do servidor.
  3. **Torna o contra-ataque justo:** se os dois atacam quase juntos, os dois
     ataques ainda estão na janela e se cancelam.
- O cliente usa `readyAt` + o offset de Cristian para pintar a barra
  ("a caminho" → "pronto") no instante certo sem precisar de nova mensagem.

### Quando o lixo entra
- Só quando o jogador **trava uma peça sem limpar linhas**: o servidor retira
  da fila todas as entradas prontas e envia `garbage_apply`. A partir daí
  elas não podem mais ser canceladas. Se a peça limpou linhas, nada entra
  (o ataque dele foi usado para cancelar).
- Por que no travamento e não num timer: é o comportamento padrão do Tetris
  competitivo e evita o lixo empurrar o tabuleiro no meio de uma jogada.
  Também amarra a aplicação a um evento do cliente, então o servidor nunca
  aplica lixo "por conta própria" num tabuleiro que ele não vê.
- O cliente insere as linhas assim que recebe `garbage_apply` com
  `addGarbage()` da engine (fase 1). Se a peça ativa colidir, ela sobe; se o
  tabuleiro transbordar, é game over pelo fluxo normal de `game_over`.
- O tabuleiro do adversário mostra o lixo no próximo `piece_locked`, que
  manda o tabuleiro inteiro.

### Ordem de chegada e ataques simultâneos
- O Node processa um evento por vez; o servidor trata cada `piece_locked` por
  completo (cancelar + enfileirar) antes do próximo. Dois ataques "simultâneos"
  são, portanto, resolvidos na ordem em que chegaram, e o log mostra a ordem.
- Exemplo do teste: A ataca 4 e B ataca 2 quase juntos. Se A chega primeiro,
  B recebe 4 e depois cancela 2 com o próprio ataque (fica com 2). Se B chega
  primeiro, A recebe 2 e cancela 2 com o ataque de 4, enviando 2 a B. As
  mensagens intermediárias diferem, mas o resultado final das filas é o mesmo
  (A=0, B=2): o cancelamento faz o saldo depender só da diferença dos ataques.
- **Ressalva:** isso só vale se **nenhum lixo for aplicado entre os dois
  ataques**. Lixo aplicado sai da fila e não pode mais ser cancelado; se o
  primeiro ataque já tiver entrado no tabuleiro do adversário quando o segundo
  chega, o segundo não tem o que cancelar e vai inteiro, e o saldo passa a
  depender da ordem. A janela de 500 ms é justamente o período em que essa
  propriedade vale: enquanto o ataque está "a caminho", ele ainda não pode ser
  aplicado, então ataques que chegam dentro dessa janela se compensam
  independentemente da ordem.

### Testes (fase 3)
- `npm test` roda os testes da engine e os de protocolo. O de protocolo sobe
  o próprio servidor na porta 3999 e usa clientes Socket.IO simulados
  (`socket.io-client` como dependência só de desenvolvimento).

## Fase 4 — Power-up disputado (exclusão mútua)

### Algoritmo do coordenador (exclusão mútua centralizada)
- O power-up é um **recurso único** que os dois jogadores querem ao mesmo
  tempo, e só um pode ficar com ele: é um problema de exclusão mútua.
- Usamos o **algoritmo centralizado (coordenador)**: o servidor é o
  coordenador. Os clientes **pedem** o recurso (`powerup_claim`); o
  coordenador atende os pedidos em ordem de chegada; o primeiro pedido válido
  recebe o recurso (`powerup_granted`) e os demais são negados
  (`powerup_denied`). Não há "liberação" porque o recurso é consumido por
  quem o recebe; o próximo power-up é um recurso novo.
- **Por que este algoritmo:**
  - Já temos um servidor central que é autoridade sobre o estado
    compartilhado; ele é o coordenador natural, sem custo extra.
  - Precisa de só **2 mensagens por pedido** (pedido + resposta), contra
    2(n−1) do Ricart–Agrawala ou a circulação contínua do token ring.
  - É simples de explicar e de verificar: a decisão acontece num único lugar.
  - Desvantagem clássica: o coordenador é ponto único de falha. Aqui isso não
    pesa, porque se o servidor cair o jogo inteiro já para.
- **Atomicidade:** no handler do pedido, verificar se o recurso está livre e
  marcá-lo como concedido acontecem sem nenhum `await`/callback no meio
  (comentado como SEÇÃO CRÍTICA em `server/powerups.js`). O Node executa um
  handler por vez numa única thread, então nenhum outro pedido é processado
  entre a verificação e a marcação. É isso que garante que dois pedidos quase
  simultâneos nunca recebem os dois o recurso.

### Por que o pedido é validado pelo servidor
- O cliente só *pede*; quem decide se o pedido é legítimo é o coordenador:
  1. o `powerupId` precisa ser o power-up ativo (senão "expirado" ou
     "inexistente");
  2. ele não pode já ter dono (senão "o adversário pegou primeiro");
  3. o **último `piece_locked` desse jogador recebido pelo servidor depois do
     surgimento** precisa ter `linesCleared >= 2` (senão "pedido inválido").
- A condição 3 usa a informação que o próprio servidor recebeu (e
  validou na fase 3), e não algo que o cliente afirma no pedido. Um cliente
  modificado não consegue pegar o power-up sem ter mandado um travamento
  coerente. O cliente manda o pedido logo depois do `piece_locked`; como os
  dois vão pelo mesmo socket, o servidor recebe nessa ordem.
- A expiração também é decidida pelo servidor (timer dele, `expiresAt` no
  relógio dele). O cliente usa o offset de Cristian só para mostrar o tempo
  restante; um pedido que chega depois da expiração é negado mesmo que, na
  tela do jogador, ainda faltassem alguns milissegundos.

### Por que os efeitos ficam no servidor
- `escudo` e `dobro` alteram **ataques**, que já são calculados pelo servidor
  (fase 3). Guardar o efeito no servidor (`player.effect`) e aplicá-lo dentro
  do cálculo do ataque mantém uma única fonte de verdade: o cliente não pode
  inventar um escudo nem "esquecer" de gastar um.
- Ordem de aplicação, no handler do ataque: `dobro` do atacante dobra o
  ataque **antes** do cancelamento; depois vem o cancelamento; por fim o
  `escudo` do adversário descarta por inteiro o que iria para a fila dele.
  `dobro` só é gasto num ataque com valor > 0 (limpar 1 linha não desperdiça).
- Cada jogador guarda no máximo um efeito; ganhar outro substitui (fica no log).
  O dono é avisado quando o efeito é consumido (`powerup_consumed`).

### Ciclo de vida e testes
- O power-up surge em intervalos aleatórios de 20–30 s durante `jogando`, um
  por vez, e expira em 15 s. Tudo (power-up ativo, timers, efeitos) é zerado
  no início e no fim da partida e no "jogar de novo".
- Os tempos ficam em `shared/powerups.js` e podem ser sobrescritos por
  variáveis de ambiente (`POWERUP_SPAWN_MIN_MS`, `POWERUP_SPAWN_MAX_MS`,
  `POWERUP_DURATION_MS`), lidas só no servidor (o `/shared` não pode depender
  do Node). Os testes usam 200–300 ms e 500 ms.
- Os ids são globais e crescentes (`PU1`, `PU2`...), nunca reaproveitados, para
  um pedido atrasado de um power-up antigo nunca ser confundido com o atual.

## Fase 5 — Tolerância a falhas (desconexão e reconexão)

### Detecção de falha: heartbeat + timeout
- Numa rede real, uma queda (cabo, Wi-Fi, aba congelada) **não avisa ninguém**:
  o TCP pode ficar minutos sem perceber. A única forma de detectar é esperar
  sinais de vida periódicos e declarar falha quando eles param.
- O Socket.IO faz isso com um heartbeat: o servidor manda `ping` a cada
  `HEARTBEAT_INTERVAL_MS` (2 s) e, se o `pong` não voltar em
  `HEARTBEAT_TIMEOUT_MS` (3 s), considera a conexão morta (motivo
  `ping timeout` no log). Pior caso para detectar: ~5 s. O padrão do Socket.IO
  (25 s + 20 s) deixaria o adversário até 45 s sem saber de nada.
- Trade-off: intervalo menor detecta mais rápido, mas gera mais tráfego e
  aumenta o risco de **falso positivo** (uma rede lenta por 3 s vira "queda").
  Como a queda não é punida na hora (ver abaixo), um falso positivo só causa
  uma pausa curta, então dá para usar valores agressivos.
- O log registra o instante (timestamp do servidor) e o motivo informado pelo
  Socket.IO (`ping timeout`, `transport close`, `client namespace disconnect`...).
- Detecção testada simulando um cliente que para de responder aos pings:
  queda percebida em ~3,8 s.

### Por que pausar em vez de punir
- O servidor **não consegue distinguir** "o jogador desistiu" de "a rede dele
  caiu por 2 s" — num sistema distribuído assíncrono, um processo lento e um
  processo morto parecem iguais. Dar a vitória ao outro na hora puniria falhas
  de rede que não são culpa do jogador.
- Por isso a partida vai para o estado `pausada` e o servidor espera até um
  prazo (`RECONNECT_TIMEOUT_MS`, 30 s). Voltou: retoma. Não voltou: W.O.
  O prazo transforma a incerteza ("lento ou morto?") numa decisão: depois de
  30 s, o servidor *decide* que o processo falhou.
- Durante a pausa, tudo que depende do tempo de jogo é congelado:
  - os dois clientes param (`match_paused` com `deadline` no relógio do
    servidor, mostrado como contagem regressiva);
  - o power-up ativo é cancelado (`powerup_expired`) e o timer de surgimento
    recomeça na retomada; os efeitos já ganhos são mantidos;
  - o `readyAt` de toda entrada da fila de lixo é adiado pelo tempo congelado
    (do início da pausa até `resumeAt`, incluindo a contagem 3-2-1). Assim um
    ataque que faltava 300 ms para ficar pronto continua faltando 300 ms quando
    o jogo volta, e quem caiu não leva lixo "amadurecido" durante a pausa.
- A retomada usa o mesmo esquema do início: `match_resume { resumeAt }` com
  horário absoluto do servidor (agora + 3 s), convertido pelo offset de
  Cristian, para a contagem terminar junto nos dois navegadores.
- `piece_locked` e `game_over` ainda são aceitos em `pausada`: são mensagens
  que o jogador que ficou enviou antes de saber da pausa (estavam "em voo").
- Se os dois caem, o prazo continua o mesmo; vencido sem ninguém de volta, a
  sala é descartada.

### Identidade de sessão
- Ao reconectar, o socket é **outro** (novo id); o servidor precisa de outra
  forma de saber que é o mesmo jogador. No `room_joined` ele envia um
  `sessionToken` aleatório (`crypto.randomUUID`, impossível de adivinhar), que
  o cliente guarda no `sessionStorage` (sobrevive ao F5, morre ao fechar a aba).
- Ao (re)conectar com token salvo, o **primeiro** envio é `rejoin`; a
  sincronização de relógio só começa depois da resposta.
- No servidor, cada conexão aponta para um objeto jogador (`conn.player`). Um
  `rejoin` aceito troca para o jogador antigo, que mantém sala, `lastSeq`, fila
  de lixo, efeito e checkpoint. Se a conexão antiga ainda parecia viva, é
  derrubada, e a queda dela é ignorada (o jogador já está em outra conexão).
- Rejeições (`rejoin_failed`): token desconhecido, token de outra sala, ou
  partida já encerrada. O cliente limpa o `sessionStorage` e volta ao menu.
- Fora de uma partida (sala aguardando/encerrada), a queda remove o jogador
  da sala como antes e invalida o token.

### Checkpoint baseado na semente determinística
- O servidor não simula o tabuleiro de ninguém, então não tem como "devolver o
  jogo" a quem recarregou a página. Mas não precisa guardar tudo: como as peças
  vêm de um gerador determinístico, basta um **checkpoint pequeno** enviado em
  cada `piece_locked`: `board`, `hold`, `piecesLocked`, `score`, `lines`.
- Reconstrução (`TetrisGame.fromCheckpoint`): mesma semente, pula no gerador
  as peças já usadas e restaura tabuleiro, hold e pontuação. As peças usadas
  são `piecesLocked` **+ 1 se houver peça no hold**: o primeiro hold puxa uma
  peça nova do gerador, então a peça guardada também conta. O teste da engine
  compara jogo original e reconstruído em ~370 checkpoints com holds aleatórios.
- O lixo aplicado pelo servidor (`garbage_apply`) também entra no checkpoint
  (`pushGarbage`, a mesma função pura da engine). Sem isso, um F5 logo depois
  de receber lixo "apagaria" o lixo.
- Limitação aceita: a peça que estava caindo e qualquer hold feito depois do
  último travamento são perdidos (o jogo volta ao estado do último
  `piece_locked`).
- Se **só o socket caiu** (sem F5), o cliente ainda tem o jogo em memória, mais
  recente que o checkpoint; nesse caso ele mantém o estado local e usa do
  `state_sync` só o que vem do servidor (fila de lixo, efeito, tabuleiro do
  adversário). Se perdeu enquanto estava desconectado, reenvia `game_over`.

### O problema do seq depois de recarregar a página
- O servidor guarda o último `seq` aceito de cada jogador e descarta tudo que
  for menor ou igual. Depois de um F5, o cliente recomeça a contar do zero:
  todas as mensagens novas (`seq` 1, 2, 3...) seriam descartadas como
  "antigas", e o jogador ficaria mudo para o servidor.
- Solução: o `rejoin` é tratado ainda na identidade provisória da conexão nova
  (que começa com `lastSeq = 0`), e o `state_sync` devolve o `lastSeq` do
  jogador antigo. O cliente continua a numeração a partir dele.
- O filtro continua valendo depois da reconexão: uma mensagem com `seq` antigo
  que chegue depois do `rejoin` é descartada (testado).
- Enquanto está desconectado, o cliente **não envia** nada (descarta na
  origem). Por padrão o Socket.IO guardaria essas mensagens e as mandaria ao
  reconectar **antes** do `rejoin`, numa conexão que o servidor ainda não sabe
  de quem é. Como o jogo está parado durante a queda, só se perdem mensagens
  que não importam, e o estado é ressincronizado pelo `state_sync`.

### Testes (fase 5)
- `tests/reconnect.test.js` sobe o servidor na porta 3998 com prazo de 1,5 s e
  cobre: queda e volta com o mesmo token (pausa e `resumeAt` iguais), F5 com
  socket novo (checkpoint, fila, `lastSeq`, mensagens novas aceitas), W.O.,
  token inválido e de outra sala, `readyAt` adiado exatamente pela pausa,
  power-up cancelado na pausa, os dois caindo, e `seq` antigo após reconexão.

## Fase 6 — Ferramentas de demonstração

Regra da fase: **nada aqui altera a lógica do jogo ou do protocolo** existente.
Os acréscimos são observação (monitor, painel) e injeção de falhas controlada
(latência, queda). A suíte das fases anteriores continua passando sem mudança.

### Monitor do servidor (`/monitor`)
- **Observabilidade do sistema distribuído:** o estado "verdadeiro" do jogo
  está no servidor (é ele quem decide). O monitor mostra esse ponto de vista
  — salas, filas de lixo, power-up, efeitos e a ordem real em que os eventos
  foram processados, com o **timestamp do servidor**, que é a referência de
  tempo do sistema.
- O logger passou a gerar, além da linha no console, uma entrada estruturada
  (`ts`, jogador, sala, `seq`, evento, classificação) que vai em tempo real
  para os sockets na room `monitor` e fica num histórico curto (500 entradas).
- **Conexão separada do jogo:** o monitor usa o mesmo Socket.IO, mas se
  identifica no handshake (`auth.role = 'monitor'`) e é desviado para outro
  handler; nunca vira jogador nem passa pelo código das salas.
- **Classificação de conflitos** (destaque por cor): power-up negado por
  "adversário pegou primeiro", lixo cancelado, escudo bloqueando, mensagem
  descartada por `seq`, queda/pausa e retomada. É feita só lendo o texto do
  log, sem tocar na lógica.
- **Acesso:** com `MONITOR_KEY` definida, exige `?key=` igual (comparação em
  tempo constante, `timingSafeEqual`); sem ela, só aceita conexões da própria
  máquina (em produção, sem ela o monitor fica desativado; ver fase 7). A checagem vale para a página e, principalmente, para o socket
  (é por ele que os dados passam). O HTML fica em `/server`, fora da pasta
  servida estaticamente. O `sessionToken` é ocultado no log (`[oculto]`),
  porque o monitor pode estar projetado.
- **"Forçar power-up agora"** chama o mesmo `spawnPowerup` do jogo normal; só
  pula a espera aleatória. O handler existe apenas nos sockets de monitor
  autenticados: um jogador que emitir o mesmo evento não é ouvido (testado).
- Os clientes informam RTT e offset ao servidor a cada 5 s (`clock_report`,
  evento novo e só informativo) para o monitor exibir.

### Latência artificial no cliente
- Aplicada **num único ponto** (`latency.schedule` em `client/net.js`) para
  tudo o que a aba envia e recebe, inclusive os pings de Cristian. Por isso o
  RTT medido passa a incluir a latência simulada; o painel refaz a
  sincronização ao mudar o valor. Com atraso simétrico, o offset continua
  perto de zero, o que mostra que Cristian estima o relógio corretamente
  mesmo com RTT alto (o erro é limitado por RTT/2).
- **FIFO por padrão**, como o TCP sobre o qual o Socket.IO roda: o jitter
  atrasa, mas uma mensagem nunca ultrapassa a anterior. Com "permitir
  reordenação", cada mensagem tem atraso independente (como pacotes UDP) e o
  jitter pode inverter a ordem; o servidor então descarta pelo `seq` as que
  chegam depois de uma mais nova. No teste, com 25 mensagens e jitter de
  300 ms, ~70–90% foram descartadas: o filtro garante a ordem, mas
  **perde** mensagens. É o motivo de o protocolo real depender de um
  transporte ordenado (TCP).
- O `seq` é atribuído no envio, antes do atraso, exatamente para a
  reordenação ficar visível no servidor.
- O simulador é um módulo puro (`client/latency.js`), sem DOM; os testes usam
  o mesmo código do navegador.
- Aviso fixo na tela sempre que há latência ativa, para ninguém esquecer.

### Simular queda
- O botão fecha o transporte por baixo do Socket.IO (`engine.close()`), sem
  mandar o pacote de saída voluntária. O servidor recebe `transport close` e
  segue o caminho de **falha** (pausa → reconexão → W.O.), o mesmo de uma
  queda real. A reconexão automática fica desligada até "Reconectar".
- Observação: o servidor trata qualquer queda durante a partida da mesma forma
  (não há como distinguir de longe); a diferença aparece no motivo registrado
  no log (`transport close` × `client namespace disconnect`).

### Painel de debug (F2)
- Escondido por padrão; só a tecla F2 é tratada por ele. Ao fechar, tira o
  foco de qualquer controle do painel, para um slider ou botão focado não
  reagir às teclas do jogo.

### Testes (fase 6)
- `tests/demo.test.js` (porta 3997, com `MONITOR_KEY`): chave errada e certa
  (HTTP e socket), log ao vivo, RTT no retrato, forçar power-up só pelo
  monitor, FIFO preserva a ordem, reordenação gera descartes por `seq`
  (contagem igual no log e no monitor), 500 ms de latência fazem perder a
  disputa, e "simular queda"/"reconectar".

## Fase 7 — Deploy no Render

Regra da fase: sem mudanças na lógica do jogo ou no protocolo. Só configuração,
diagnóstico e as regras de acesso do monitor em produção.

### Cenário da apresentação
- Jogo hospedado no Render; cada jogador numa máquina, pela internet. É a
  primeira vez que o sistema roda **de fato distribuído**: a latência entre
  os jogadores é real e diferente para cada um (a coluna RTT do monitor mostra).

### Uma única instância
- O estado das salas (jogadores, filas de lixo, power-up, sessões) fica **em
  memória, no processo do servidor**. Duas instâncias teriam dois `Map` de
  salas independentes: um jogador conectado à instância 1 não encontraria a
  sala criada na instância 2.
- Escalar horizontalmente exigiria:
  - **sessões fixas (sticky sessions)**: o balanceador manda todas as
    requisições de um cliente para a mesma instância (o Socket.IO precisa
    disso, porque o handshake e o long-polling fazem várias requisições HTTP);
  - um **adaptador compartilhado**, como o Redis adapter do Socket.IO, para
    um `emit` numa instância chegar a sockets conectados em outra;
  - e, principalmente, tirar o estado das salas da memória (Redis ou banco),
    com algum cuidado de concorrência: o coordenador do power-up hoje é
    correto **porque** um único processo Node trata um evento por vez.
- Para dois jogadores numa apresentação, uma instância sobra. A escolha também
  mantém o servidor como **coordenador único**, que é exatamente o modelo
  centralizado estudado (com o ponto único de falha que ele implica).

### Por que não a Vercel
- A Vercel executa o back-end como **funções serverless**: cada requisição pode
  cair numa instância nova, que vive só durante a resposta. Isso não serve aqui:
  - **WebSocket** é uma conexão longa e com estado; funções serverless não
    mantêm conexões abertas entre requisições;
  - o **estado em memória** (salas, filas, timers de power-up e de reconexão)
    se perderia a cada invocação;
  - os **timers do servidor** (contagem, surgimento do power-up, prazo de W.O.)
    precisam de um processo rodando continuamente.
- O Render roda um processo Node comum, sempre ligado (enquanto acordado), que
  é o modelo para o qual o servidor foi escrito.

### Configuração (`render.yaml`)
- Blueprint com um Web Service Node, plano free, região Virginia, build
  `npm ci` (instalação exata do `package-lock.json`), start `npm start`,
  health check em `/health` e `NODE_ENV=production`.
- Com `NODE_ENV=production`, o `npm ci` **não instala devDependencies**. Isso
  serve também de verificação: `socket.io-client` (só dos testes) fica de fora,
  e nada de produção depende dele (testado simulando o build numa cópia limpa).
- `MONITOR_KEY` é declarada com `sync: false`: o Render pede o valor na
  criação, e ele nunca vai para o repositório.
- `engines.node` = `26.x`, a versão usada no desenvolvimento.
- O servidor escuta em `process.env.PORT` (o Render define a porta).
- `GET /health` responde 200 com `{status, version}`; o Render só considera o
  deploy pronto (e só troca a versão antiga pela nova) quando ele responde.

### Monitor em produção
- **`MONITOR_KEY` obrigatória em produção.** Sem ela, com
  `NODE_ENV=production`, o monitor fica desativado (404 na página, socket
  recusado).
- **Por que a regra "só localhost" não serve em produção:** atrás do proxy do
  Render (ou de um túnel como o `cloudflared`), toda conexão TCP chega ao Node
  vinda do proxy, que pode estar na mesma máquina. O endereço deixa de
  identificar o usuário. Por isso em produção a única forma de acesso é a chave.
- **Nada confia em `X-Forwarded-For`.** A checagem de localhost usa o endereço
  da conexão TCP (`req.socket.remoteAddress` / `handshake.address`), e o
  Express não tem `trust proxy` ligado. Esse cabeçalho é escrito pelo cliente
  (ou por qualquer proxy no caminho) e pode ser forjado: um atacante mandaria
  `X-Forwarded-For: 127.0.0.1` para se passar por local. Testado: o cabeçalho
  não muda a decisão em nenhum dos modos.
- **Modo compacto** (`?compact=1`): cabe em meia tela de 1920×1080, ao lado da
  janela do jogo projetada. Mostra só a timeline da "sala atual" (a do evento
  mais recente), com os destaques de conflito, uma linha com estado da sala e
  RTT dos jogadores, e o botão de forçar power-up.

### Diagnóstico em produção
- **Versão do build** (`/version`, rodapé do menu e cabeçalho do monitor):
  hash curto do commit, lido de `RENDER_GIT_COMMIT` (definida pelo Render); "dev"
  localmente. Serve para confirmar qual versão está no ar antes de apresentar.
- O log continua indo para `stdout` (aparece na aba Logs do Render); a linha
  de inicialização informa versão, `NODE_ENV` e o modo do monitor.

### Testes (fase 7)
- `tests/production.test.js` sobe o servidor como no Render: `/health`,
  versão (`dev` e hash do commit), monitor desativado sem chave em produção,
  chave obrigatória mesmo em localhost, `X-Forwarded-For` ignorado, e uma
  partida curta funcionando em modo produção.
