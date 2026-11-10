# whatsapp-jar

A multi-tenant AI agent chat that behaves like WhatsApp: each user has one endless thread with the agent. It has a web chat and a WhatsApp channel.

Stack: TypeScript, Next.js, Postgres (plain `pg`, SQL migrations), Vercel AI SDK with `@ai-sdk/anthropic`.

## Run it

Needs Node 22+ and Docker.

```bash
npm install
cp .env.example .env     # set SESSION_SECRET (openssl rand -hex 32) and ANTHROPIC_API_KEY
npm run db:up            # Postgres on 127.0.0.1:5433
npm run db:migrate
npm run db:seed          # tenants Acme (Alice, Bob) and Globex (Carol)
npm run build && npm start
```

Open http://localhost:3000 and pick a user. Without an API key everything works except replies: the agent posts a notice in the chat.

`npm test` runs the integration suite against a `whatsapp_jar_test` database. It needs `npm run db:up` and no API key, because a fake Anthropic HTTP server stands in for the model.

The worker runs inside the Next.js server, so run it as a long-lived process rather than on serverless functions.

## Layout

- `src/core/` is the chat core, with no web imports. `mcp.ts` connects it to a remote MCP server.
- `src/app/` is the web channel: login, API routes and the chat UI.
- `src/whatsapp/` is the WhatsApp channel. `gateway.ts` is the logic and `main.ts` is the open-wa process.
- `db/migrations/` is the schema.

A channel does two things: it calls `receiveMessage()` with a `dedupeKey`, and it delivers the assistant rows that appear in `messages`. The web UI polls for them. WhatsApp sends them.

## Connected MCP server

Set `MCP_URL` and the agent can use that server's tools in every chat, on the web and on WhatsApp. It is built for [slash-dhan-mcp](https://dhan-mcp-test1.slash.markets), which answers Indian market-data questions through a `run_python` tool: the user asks in chat, the agent writes and runs the script on that server, and replies with the result.

At the first turn the process asks the server for its tools (`tools/list`) and fetches its `SKILL.md`, the guide that teaches the model to use them. The tools are offered to the model unchanged and the guide goes at the end of the system prompt. Both are then kept for the life of the process, because a change to either rewrites the prompt cache. Restart to pick up a new server version.

- With `MCP_URL` set the agent is a markets-only analyst: it declines other topics, never claims it can trade, and takes every figure from the tools. `AGENT_SCOPE=general` keeps it an open assistant that also has the tools.
- The server must speak Streamable HTTP without authentication and answer each request statelessly, as slash-dhan-mcp does.
- If the server can't be reached at the start, the agent answers without the tools and tries again 30 seconds later. If a tool call fails, the model is told and says so.
- `MCP_TOOLS` narrows the tools on offer. slash-dhan-mcp also has `create_watcher` and `list_watchers`: watchers alert by email, and the list shows every watcher on that host with its email address, to anyone who asks.
- The guide adds about 6,000 tokens to every request. Tool calls and results are stored in the turn's transcript, so market questions fill `HISTORY_TOKEN_BUDGET` faster than plain chat.

## WhatsApp

One WhatsApp number is linked by the operator, and people chat with Jar by messaging it. There is no login: a number gets its own user and thread the first time it writes. It uses [open-wa](https://openwa.dev), which drives WhatsApp Web in headless Chrome. That is unofficial, so WhatsApp can ban the number.

```bash
# in .env: WHATSAPP_ALLOWED_NUMBERS=919876543210   (or WHATSAPP_OPEN=true)
npm run db:migrate
npm run whatsapp         # scan the QR code it prints, once
```

Needs Chrome on the machine. The session is saved in `.whatsapp-session/`, which is as sensitive as a password. Run one such process per number, under a supervisor that restarts it: it exits when the session drops. It runs the turn worker itself, so the web server is optional.

**Who is answered.** Only direct chats. Groups, status updates and the number's own messages are ignored. `WHATSAPP_ALLOWED_NUMBERS` limits it to those numbers and `WHATSAPP_OPEN=true` answers anyone. One of the two must be set, because on a personal number "anyone" means all your contacts. If an allowed number is still ignored, the log line shows the chat id WhatsApp used for it, and that id can go in the list as is.

**Limits.** All limits are off unless set, so nobody is restricted by default. The cost of every turn is still recorded on its `turns` row. `WHATSAPP_DAILY_MESSAGES` and `WHATSAPP_DAILY_USD` cap each number per day, resetting at midnight in `WHATSAPP_TIMEZONE` (Asia/Kolkata); 30 messages and $2 are reasonable values for a public number. `WHATSAPP_GLOBAL_DAILY_MESSAGES` and `WHATSAPP_GLOBAL_DAILY_USD` cap all numbers together. With a limit set, a message over it is not stored, and the number gets one notice a day. Cost is known only when a turn finishes, so the dollar limits can overshoot by one turn.

**Delivery.** Replies waiting to go out are assistant and system rows with `delivered_at` NULL. They are sent oldest first, and a failed send holds back that thread's later replies until it succeeds or fails 5 times. If the process dies between sending and recording it, that reply is sent twice. Quoted replies work both ways. The usage line stays in the web chat.

**Not handled.** Messages sent while the process is down are not picked up afterwards. Media gets a "text only" notice. The user's name is fixed at first contact.

WhatsApp users are left out of the demo login page, so their chats can't be opened from the web.

## How it works

**Storage.** `messages` is the permanent chat log with timestamps. `turns` holds one row per finished turn, with the exact model transcript including tool calls and results. All tables carry `tenant_id`, and composite foreign keys stop a reply or turn link from crossing a tenant or thread.

**Rolling window.** Each turn the model gets whole turns from the thread's window start, plus the new batch, which is always included. A turn is a single row, so the cut can't split a tool call from its result. When the total passes `HISTORY_TOKEN_BUDGET`, the start jumps forward until the kept turns fit half the budget, and it never moves back. Token counts are an estimate of JSON length / 3.

Thinking blocks are not stored. They are signed against the exact history that produced them, and the window changes that history every turn, so replaying them gets a 400 on newer Anthropic accounts. They stay live within a turn.

**Prompt caching.** The system prompt and tools are identical on every turn. What changes (the current time, and whether older history exists) goes in a `<system-reminder>` block at the end of the batch. That block is stored in the turn's transcript and replayed unchanged, so earlier turns stay byte-identical, and it never enters the `messages` table, so the UI, search and quotes can't see it.

Requests use Anthropic's automatic caching for the moving tail, plus one explicit breakpoint on the previous turn's batch, in case a long tool turn runs past the 20-block lookback. Markers are added to the request only and never stored. Each turn reads up to the previous batch and writes the rest. Everything after that point has to be rewritten anyway because thinking is stripped from replays.

The TTL is 1 hour (`PROMPT_CACHE_TTL=5m` to change it), because chat replies often come 5 to 60 minutes apart. A miss costs 2x input price, so a chat with more than an hour between messages pays more than with no cache. Each window jump also causes one full rewrite, which is why it trims in large steps. The tools and system prompt alone pass Opus 5.5's 512-token minimum, so even a first message caches.

**Search.** `search_messages` uses a Postgres `tsvector` GIN index that includes `thread_id`, with English stemming. It tries all words, then any word. `read_messages_around` reads the context of a hit. The tools take their thread from the turn, never from model input. Non-English text is matched without stemming, and typos don't match.

**Reply to a message.** `reply_to_id` is stored, and the quoted text is rendered into the user message itself, so it reaches the model even if the original left the window. The agent quotes a message with `reply_to_message`.

**Back-to-back messages.** All state is in Postgres:

1. `receiveMessage()` only stores the message. A user message with `turn_id` NULL is the inbox.
2. The worker polls every 500ms for threads that have been quiet for `DEBOUNCE_MS` (3s), or whose oldest message has waited `DEBOUNCE_MAX_MS` (15s). The whole inbox becomes one batch, and the prompt tells the agent to handle each request in it.
3. A lease on the thread row means one turn at a time per thread. It has a heartbeat and expires if the worker dies.
4. Before each loop step, `prepareStep` adds anything new from the inbox, so a message sent mid-turn joins the running turn. One that lands during the final step stays in the inbox and starts the next turn.
5. A turn commits in one transaction, and only while the lease is still held. A crash or failure writes nothing, so the messages stay in the inbox and run again. Replies therefore appear when the turn finishes, with no streaming.

Failed turns retry up to 3 times. After that, or on a permanent error, the chat gets a notice and the transcript records that the messages went unanswered, so the thread can't get stuck.

**Usage line.** Each turn ends with one small line under its last reply, such as `2,338 in · 135 out · 0 cached · $0.0120`. It totals all the turn's model steps. `in` is all input including cached tokens, and `out` includes thinking.

Usage is stored on the `turns` row, beside the transcript rather than in it, so it can't reach the model, the window or search. Prices are in `src/core/pricing.ts`, and each turn's cost is fixed when the turn commits. A model missing from that table shows tokens with no cost. So does a step where a declined attempt preceded a fallback, because the response doesn't say whether that attempt was billed. Attempts that were billed and then failed are added to the turn that follows. Usage is lost only if a worker crashes or loses its lease mid-turn.

## Not built yet

- Real authentication for the web chat. Login is a demo user picker with a signed cookie, and anyone who can open `/login` can be any web user.
- Streaming, read receipts and attachments.
