# whatsapp-jar

A multi-tenant AI agent chat that behaves like WhatsApp: each user has one endless thread with the agent. Web only for now.

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

- `src/core/` is the chat core, with no web imports.
- `src/app/` is the web channel: login, API routes and the chat UI.
- `db/migrations/` is the schema.

A new channel needs two things: call `receiveMessage()` with a `dedupeKey` (a WhatsApp message id, say), and deliver the assistant rows that appear in `messages`. Delivery doesn't exist yet because the web UI simply polls.

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

- Real authentication. Login is a demo user picker with a signed cookie, and anyone who can open `/login` can be anyone.
- Streaming, read receipts and attachments.
