# Futebol Bot WhatsApp

Bot em Node.js para gerenciar o futebol semanal pelo WhatsApp usando Evolution API, persistencia local JSON, Google Sheets opcional, automacoes com cron e painel administrativo simples.

## Recursos

- Convocacao automatica segunda-feira as 09:00.
- Lembrete privado terca-feira as 11:00 para mensalistas pendentes.
- Fechamento terca-feira as 12:00 com resumo no grupo.
- Mensagem de jogo quarta-feira as 08:00.
- Comandos de WhatsApp para mensalistas, avulsos e administradores.
- API REST e painel em `/`.
- Deploy pronto para Railway com `Procfile`.

## Estrutura

```txt
src/
  index.js       Servidor Express e webhook
  database.js    Persistencia JSON
  handlers.js    Comandos WhatsApp
  whatsapp.js    Evolution API
  sheets.js      Google Sheets opcional
  scheduler.js   Cron jobs
  routes.js      API REST
public/
  index.html     Painel admin
data/
  estado.json    Estado local
```

## Rodar localmente

```bash
npm install
cp .env.example .env
npm start
```

Acesse `http://localhost:3000`.

Sem variaveis da Evolution API, o envio de WhatsApp roda em modo `dry-run` e aparece no console.

## Variaveis de ambiente

Copie `.env.example` para `.env` e preencha:

```env
PORT=3000
EVOLUTION_API_URL=
EVOLUTION_API_KEY=
EVOLUTION_INSTANCE=
WHATSAPP_GROUP_ID=
ADMIN_NUMBERS=5511999999999,5511888888888
ADMIN_API_TOKEN=
TOTAL_VAGAS=20
TOTAL_MENSALISTAS=17
VALOR_AVULSO=20
TIMEZONE=America/Sao_Paulo
GOOGLE_SHEET_ID=
GOOGLE_SERVICE_ACCOUNT_EMAIL=
GOOGLE_PRIVATE_KEY=
```

## Comandos WhatsApp

Usuarios:

```txt
/confirmar sim
/confirmar nao
/confirma nao
/querojogar
/lista
/ajuda
```

Administradores, somente no privado do bot:

```txt
/admin nova-semana
/admin convocar
/admin fechar
/admin abrir
/admin resumo
/admin add-mensalista telefone nome
/admin rm-mensalista telefone
```

Comandos admin enviados no grupo sao bloqueados por seguranca.

## API REST

```txt
GET    /api/status
GET    /api/jogadores
GET    /api/avulsos
POST   /api/mensalista
DELETE /api/mensalista/:telefone
POST   /api/acao/nova-semana
POST   /api/acao/convocacao
POST   /api/acao/fechar
POST   /api/acao/abrir
POST   /api/acao/resumo
POST   /api/acao/mensagem
POST   /webhook
```

Exemplo para adicionar mensalista:

```bash
curl -X POST http://localhost:3000/api/mensalista \
  -H "Content-Type: application/json" \
  -d "{\"telefone\":\"5511999999999\",\"nome\":\"Joao\"}"
```

## Webhook Evolution API

Configure o webhook da Evolution API para:

```txt
https://meu-projeto.up.railway.app/webhook
```

O endpoint aceita eventos `MESSAGES_UPSERT` e tenta extrair texto de formatos comuns da Evolution API.

## Google Sheets

A integracao e opcional. Para ativar:

1. Crie uma Google Service Account.
2. Copie `client_email` para `GOOGLE_SERVICE_ACCOUNT_EMAIL`.
3. Copie a chave privada para `GOOGLE_PRIVATE_KEY`, mantendo `\n`.
4. Crie uma planilha e compartilhe com o email da Service Account.
5. Copie o ID da planilha para `GOOGLE_SHEET_ID`.

As colunas usadas sao:

```txt
Data | Nome | Telefone | Tipo | Status
```

## Deploy na Railway

1. Crie uma conta na Railway.
2. Crie um novo projeto a partir deste repositorio.
3. Adicione as variaveis de ambiente:
   - `EVOLUTION_API_URL`
   - `EVOLUTION_API_KEY`
   - `EVOLUTION_INSTANCE`
   - `WHATSAPP_GROUP_ID`
- `ADMIN_NUMBERS`
- `ADMIN_API_TOKEN`
   - `GOOGLE_SHEET_ID`
   - `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `GOOGLE_PRIVATE_KEY`
   - `TOTAL_VAGAS`
   - `TOTAL_MENSALISTAS`
   - `VALOR_AVULSO`
   - `TIMEZONE`
4. O start command sera `npm start`.
5. Configure o webhook da Evolution apontando para `https://meu-projeto.up.railway.app/webhook`.
6. Conecte o WhatsApp na Evolution API.
7. Se usar Sheets, compartilhe a planilha com a Service Account.

## Persistencia local

O arquivo `data/estado.json` guarda:

- rodada atual
- status aberto ou fechado
- mensalistas
- avulsos
- configuracoes
- ultimos logs

Em Railway, o filesystem pode ser efemero. Para producao longa, considere ativar volume persistente ou migrar para um banco quando o grupo crescer.

## Seguranca

Defina `ADMIN_API_TOKEN` na Railway para proteger acoes de escrita da API e do painel. O painel aceita esse token no campo "Token administrativo opcional" e salva no navegador via `localStorage`. Os comandos `/admin` do WhatsApp tambem sao restritos aos telefones em `ADMIN_NUMBERS` e devem ser enviados no privado do bot.

## Validacao rapida

```bash
npm run check
```

Testar webhook local:

```bash
curl -X POST http://localhost:3000/webhook \
  -H "Content-Type: application/json" \
  -d "{\"event\":\"MESSAGES_UPSERT\",\"data\":{\"key\":{\"remoteJid\":\"5511999999999@s.whatsapp.net\"},\"message\":{\"conversation\":\"/ajuda\"},\"pushName\":\"Teste\"}}"
```
