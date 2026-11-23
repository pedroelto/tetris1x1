# Deploy no Render

Passo a passo para colocar o jogo no ar e usar na apresentação.

O serviço roda numa **única instância** no plano free do Render (ver o porquê
em `docs/decisoes.md`, fase 7). A configuração fica no arquivo `render.yaml`
(Blueprint) na raiz do projeto.

---

## 1. Subir o repositório no GitHub

O projeto ainda não é um repositório git. Na pasta do projeto (PowerShell):

```powershell
git init
git add .
git commit -m "Tetris 1v1 - versão para deploy"
```

Crie um repositório **vazio** em https://github.com/new (pode ser privado; não
marque "Add a README"). Depois:

```powershell
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/tetris-1v1.git
git push -u origin main
```

> Com o GitHub CLI instalado, os dois passos acima viram um só:
> `gh repo create tetris-1v1 --private --source . --push`

Confira que `node_modules/` **não** foi enviado (está no `.gitignore`).

## 2. Criar o serviço no Render (Blueprint)

1. Entre em https://dashboard.render.com e conecte sua conta do GitHub
   (se pedir, autorize o Render a ver o repositório `tetris-1v1`).
2. Clique em **New → Blueprint** e escolha o repositório.
3. O Render lê o `render.yaml` e mostra o serviço `tetris-1v1`:
   Node, plano free, região Virginia, build `npm ci`, start `npm start`,
   health check em `/health`, `NODE_ENV=production`.
4. Ele vai pedir o valor de **`MONITOR_KEY`** (está marcado como
   `sync: false`, ou seja, não fica no repositório). Gere uma chave longa e
   aleatória, por exemplo no PowerShell:

   ```powershell
   [guid]::NewGuid().ToString("N")
   ```

   Cole o valor e **guarde-o** (vai precisar para abrir o monitor).
5. Clique em **Apply**. O primeiro build leva alguns minutos. Acompanhe na aba
   **Logs** do serviço até aparecer:

   ```
   Servidor rodando em http://localhost:10000
   Versão abc1234 · NODE_ENV=production · monitor: key
   ```

   (`monitor: key` confirma que a chave foi lida. Se aparecer
   `monitor: disabled`, a `MONITOR_KEY` ficou vazia.)
6. O endereço do jogo aparece no topo da página do serviço, algo como
   `https://tetris-1v1.onrender.com` (pode ter um sufixo se o nome já existir).

### Se o build falhar por causa da versão do Node

O `package.json` pede Node `26.x` (a versão usada no desenvolvimento). Se o
Render ainda não oferecer essa versão, troque em `package.json` para
`"node": "24.x"` (ou `22.x`; o projeto funciona com Node 20+), faça commit e
push.

## 3. Conferir que está no ar

- `https://SEU-SERVICO.onrender.com/health` → `{"status":"ok","version":"abc1234"}`
- O menu do jogo mostra, discretamente no rodapé, `versão abc1234`. Esse é o
  hash curto do commit implantado: compare com `git log --oneline -1` para ter
  certeza de que a versão no ar é a que você espera.

## 4. Abrir o monitor

```
https://SEU-SERVICO.onrender.com/monitor?key=SUA_CHAVE
```

Para a apresentação (meia tela, ao lado do jogo), use o modo compacto:

```
https://SEU-SERVICO.onrender.com/monitor?key=SUA_CHAVE&compact=1
```

- Sem a chave ou com a chave errada: "Acesso negado".
- Em produção, **sem** `MONITOR_KEY` definida o monitor fica desativado (404).
- A chave fica na URL: não compartilhe esse link nem o deixe visível no
  projetor ao digitá-lo (abra a aba antes de projetar).

## 5. Logs

O log do servidor (o mesmo do terminal em desenvolvimento) aparece na aba
**Logs** do serviço no Render, com o timestamp do servidor em cada linha.

## (Opcional) Encurtar o prazo de W.O. para a demonstração

Em **Environment** no painel do serviço, adicione `RECONNECT_TIMEOUT_MS` =
`15000` (15 s em vez de 30 s). Isso **reinicia o serviço**: faça bem antes da
apresentação.

---

## Avisos práticos (leia antes da apresentação)

- **O plano free dorme** depois de ~15 minutos sem acesso. A primeira visita
  depois disso demora (pode passar de 30 s) enquanto o serviço acorda.
  **Abra o link alguns minutos antes de usar**, e mantenha uma aba aberta.
- **Todo deploy reinicia o servidor e apaga as salas em andamento** (o estado
  fica em memória). **Não faça push nem deploy durante a apresentação.** Por
  padrão o Render faz deploy automático a cada push na `main`; se quiser
  evitar surpresas, desligue em **Settings → Build & Deploy → Auto-Deploy**.
- Depois de um restart, abas abertas no meio de uma partida voltam para o menu
  ("sessão inválida"): é só criar uma sala nova.
- Confira a versão no rodapé do menu antes de começar.

---

## Plano B: rodar localmente e expor com Cloudflare Tunnel

Se o Render estiver fora do ar (ou lento para acordar), rode no seu notebook e
exponha pela internet com um túnel temporário do Cloudflare (não precisa de
conta).

1. Instale o `cloudflared` (uma vez):

   ```powershell
   winget install --id Cloudflare.cloudflared
   ```

2. Suba o servidor **em modo produção e com chave** (veja o aviso abaixo):

   ```powershell
   $env:NODE_ENV="production"; $env:MONITOR_KEY="SUA_CHAVE"; npm.cmd start
   ```

3. Em outro terminal:

   ```powershell
   cloudflared tunnel --url http://localhost:3000
   ```

   Ele imprime um endereço `https://algo-aleatorio.trycloudflare.com`. Mande
   esse link para o professor; você pode jogar em `http://localhost:3000` ou
   no mesmo link. O monitor fica em `.../monitor?key=SUA_CHAVE&compact=1`.

4. O endereço muda a cada execução do `cloudflared`, e o túnel só existe
   enquanto os dois terminais estiverem abertos.

> **Aviso:** pelo túnel, toda conexão chega ao servidor vinda do próprio
> `cloudflared`, ou seja, de **localhost**. Sem `MONITOR_KEY`, o modo de
> desenvolvimento liberaria o monitor para qualquer pessoa com o link. Por
> isso, no plano B, defina sempre `NODE_ENV=production` e `MONITOR_KEY`.
