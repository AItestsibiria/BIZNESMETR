# CLAUDE.md — AI Assistant Guide for BIZNESMETR

This file provides context and conventions for AI assistants (Claude Code and others) working in this repository.

---

## Current Repository State

BIZNESMETR is being built as a **personal assistant to a CEO**: one chat (Telegram now, MAX later) that routes everything — drafting text, creating/listing tasks, eventually calendar/mail/GitHub/CRM — through Claude with tool use.

**Sprint 1 scaffolding is in place** (caркас), but the project has not been run end-to-end yet. Stubs marked `// TODO(muziai)` are waiting on patterns from the MuziAI project (Telegram handler details, deploy pipeline, reverse proxy config). See `references/TODO_FROM_MUZIAI.md` for the list and `references/REQUEST_TO_MUZIAI.md` for the brief sent to that team.

**Project layout:**

```
/
├── prisma/
│   └── schema.prisma            # User, Message, Fact
├── src/
│   ├── index.ts                 # Express entry, mounts webhooks
│   ├── config.ts                # env loading + Zod validation
│   ├── logger.ts                # pino logger (use this, never console.*)
│   ├── db.ts                    # shared PrismaClient
│   ├── claude.ts                # Anthropic SDK + tool-use loop
│   ├── messengers/
│   │   ├── adapter.ts           # MessengerAdapter interface
│   │   ├── telegram.ts          # Telegraf-based Telegram adapter (stub)
│   │   └── max.ts               # MAX adapter stub (Sprint 2)
│   ├── core/
│   │   ├── auth.ts              # whitelist check
│   │   ├── memory.ts            # user upsert + history load/save
│   │   └── router.ts            # incoming → Claude → reply
│   ├── tools/
│   │   ├── index.ts             # tool registry + runTool dispatcher
│   │   └── schemas.ts           # Zod schemas for tool inputs
│   └── integrations/
│       └── sheets.ts            # Google Sheets TaskStore
├── references/
│   ├── REQUEST_TO_MUZIAI.md     # forwardable brief
│   └── TODO_FROM_MUZIAI.md      # list of pending integration points
├── Dockerfile
├── docker-compose.yml
├── package.json
├── tsconfig.json
├── .env.example
├── .dockerignore
└── .gitignore
```

**Branches:**
- `main` — empty (docs only — Sprint 1 scaffolding lives on the working branch)
- `claude/<description>-<id>` — Claude Code working branches

---

## Project Overview

**BIZNESMETR** is a personal CEO assistant: a single Telegram/MAX entry point that dispatches messages to tools (tasks in Google Sheets, soon Calendar / Gmail / GitHub / CRM) via Claude.

**Repository:** `aitestsibiria/biznesmetr`
**Primary remote:** `origin`
**Runtime:** Node.js 20
**Stack:** Express · TypeScript (strict) · PostgreSQL + Prisma · Telegraf · Anthropic SDK · googleapis · Zod · pino

**Hosting target:** self-hosted VPS, deployed via Docker Compose, reverse-proxied (Caddy/Traefik TBD per MuziAI conventions).

---

## Commands

```bash
npm run dev              # Start dev server with hot reload (tsx watch)
npm run build            # tsc → dist/
npm run start            # Run built output
npm run typecheck        # tsc --noEmit
npm run lint             # ESLint
npm run format           # Prettier write
npm run test             # Jest
npm run db:migrate:dev   # Apply Prisma migrations locally
npm run db:migrate       # Apply migrations in prod (used by Docker entrypoint)
npm run db:test:reset    # Reset test DB — REQUIRED before running tests
npm run db:generate      # prisma generate (after schema changes)
```

---

## Architecture

### Request flow (one inbound message)

```
[Telegram | MAX]
    │ webhook (Express)
    ▼
[MessengerAdapter]  → InboundMessage { channel, userId, chatId, text, ... }
    ▼
[core/router.ts]
    ├─ auth.isAllowed()         (whitelist check)
    ├─ memory.upsertUser()
    ├─ memory.loadHistory()     (last N turns from Postgres)
    ├─ memory.saveMessage(user)
    ▼
[claude.runClaude()]            (Anthropic SDK + tool-use loop)
    ├─ rounds:
    │   ├─ messages.create() with tools
    │   ├─ stop_reason === 'tool_use' → runTool() → push tool_result → loop
    │   └─ otherwise → return text
    ▼
[memory.saveMessage(assistant)]
[MessengerAdapter.send()]
```

### Tools (Claude-callable)

Defined in `src/tools/index.ts`, validated by Zod schemas in `src/tools/schemas.ts`:

- `create_task` — append a row to the `Tasks` sheet
- `list_tasks` — read tasks, filter by status/project
- `update_task` — patch a row by id
- `draft_text` — structured marker so Claude produces a draft in its next text turn

Add a new tool by:
1. Adding a Zod schema in `tools/schemas.ts`.
2. Calling `defineTool(...)` in `tools/index.ts` and adding it to the `tools` array.
3. The router and Claude loop pick it up automatically — no wiring needed.

### Two data stores, intentionally

- **PostgreSQL (Prisma)** — internal state Claude needs: users, conversation history, facts. Not user-facing.
- **Google Sheets** — user-facing tasks hub. The CEO can open it, share it, edit it manually. The `SheetsClient` is the only writer; the `TaskStore` abstraction will let us move to Postgres-backed UI later without rewriting tools.

---

## Conventions

### Validation

Always use **Zod** at boundaries: env (`config.ts`), tool inputs (`tools/schemas.ts`), inbound webhook payloads. Parse before any business logic.

### Logging

Use the **`logger` module** (`src/logger.ts`) — never `console.log` / `console.error`. Pino, JSON in prod, pretty in dev, with redaction for tokens and auth headers.

```ts
import { logger } from './logger'
logger.info({ userId }, 'Handled message')
logger.error({ error }, 'Failed to send reply')
```

### TypeScript

- **Strict mode is on**, plus `noUnusedLocals`, `noUnusedParameters`, `exactOptionalPropertyTypes`. Remove unused imports.
- No `any`. Use `unknown` and narrow with type guards or Zod `.parse()`.
- Don't silence errors with `// @ts-ignore` / `// @ts-expect-error` without a one-line comment explaining why.
- With `exactOptionalPropertyTypes`, do **not** pass `{ key: undefined }` — spread conditionally: `...(value !== undefined ? { key: value } : {})`.

### Error handling

- Catch in the router (`core/router.ts`) and tool dispatcher (`tools/index.ts`).
- User-facing replies on failure are short and human ("Что-то пошло не так на моей стороне."). Never expose stack traces, Prisma error details, or internal paths.
- Tools return `{ ok: true, result } | { ok: false, error }` to the Claude loop; failed tool results are sent back with `is_error: true` so the model can recover.

### Adding integrations

New integration (Calendar, Gmail, GitHub, CRM):
1. `src/integrations/<name>.ts` — client + typed methods, like `sheets.ts`.
2. New tool(s) in `src/tools/` that call it.
3. Env vars in `.env.example` + `config.ts` schema.

Keep clients side-effect free at module load — lazy-init in a method, like `SheetsClient.client()`.

---

## Testing

Tests use a **real local PostgreSQL database** — not mocks.

```bash
npm run db:test:reset
npm run test
```

- Test files alongside source files or in a `__tests__/` subdirectory.
- Seed data and fixtures go through Prisma — no raw SQL.
- Each suite cleans up data it creates.
- Google APIs in tests: prefer recording fixtures or stubbing the `SheetsClient` at the integration boundary; do not hit live Sheets in CI.

---

## Branch Conventions

| Pattern | Purpose |
|---|---|
| `main` | Stable, production-ready code |
| `develop` | Integration branch for features |
| `feature/<description>` | New features |
| `fix/<description>` | Bug fixes |
| `claude/<description>-<id>` | Branches created by Claude Code |

**Never push directly to `main`.** All changes go through pull requests.

---

## Commit Message Convention

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short summary>

[optional body]
```

Common types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`.

Examples:
```
feat(tools): add gcal_create_event tool
fix(telegram): handle voice messages without text
chore(docker): align entrypoint with MuziAI pattern
```

---

## For AI Assistants

### Before Making Changes

1. **Verify what exists.** Run `ls` / `git ls-files` before assuming a file is present — some directories (`secrets/`, `.github/workflows/`) don't exist yet.
2. **Read the relevant files first.** Never edit code you haven't read.
3. **Follow existing patterns.** Look at `tools/index.ts` before adding a tool; look at `integrations/sheets.ts` before adding an integration.
4. **Scope changes to what was asked.** Don't refactor surrounding code, don't add docstrings, don't clean up unrelated areas.
5. **Respect `// TODO(muziai)` markers** — those are waiting on external input. Don't replace them with guesses; if you need to extend them, do so without removing the marker.

### Critical Rules

- Always use the `logger` module — never `console.log`.
- Always validate inputs with Zod before touching business logic.
- Never expose stack traces, Prisma errors, or token strings to the client / user.
- Remove all unused imports — strict TS fails the build otherwise.
- Don't pass `undefined` as an explicit property value with `exactOptionalPropertyTypes` on — spread conditionally.
- Before claiming tests pass, run `npm run db:test:reset` then `npm run test`.

### Security

- Never introduce command injection, SQL injection, XSS, or other OWASP Top 10 vulnerabilities.
- Use Prisma's parameterized queries — never string-interpolate user input.
- Never log secrets, tokens, passwords, or PII. The logger has a redact list — extend it if you add a new sensitive field.
- The Google service account JSON lives outside the repo (`secrets/google-credentials.json`, mounted read-only). Don't commit it; `.gitignore` already excludes the path.
- Telegram webhook secret token (`TELEGRAM_WEBHOOK_SECRET`) must be set in prod — Telegraf verifies it on every update.

### Git Workflow for AI Assistants

- Develop on the designated feature branch (see task description / system prompt).
- Commit with Conventional Commits messages.
- Push with `git push -u origin <branch-name>`.
- Do **not** create a pull request unless explicitly asked.
- Do **not** force-push or rebase published commits.

---

## Environment Variables

See `.env.example` for the full list with comments. Highlights:

| Variable | Required | Description |
|---|---|---|
| `NODE_ENV` | yes | `development` / `test` / `production` |
| `DATABASE_URL` | yes | Postgres connection string |
| `ANTHROPIC_API_KEY` | yes | Claude API key |
| `TELEGRAM_BOT_TOKEN` | for Telegram | BotFather token |
| `TELEGRAM_WEBHOOK_SECRET` | recommended | Telegraf verifies this header on each update |
| `ALLOWED_TELEGRAM_USER_IDS` | yes | Comma-separated whitelist of numeric Telegram user ids |
| `GOOGLE_APPLICATION_CREDENTIALS` | yes | Path to service-account JSON (mounted at `/run/secrets/...` in Docker) |
| `HUB_SHEET_ID` | yes | Google Sheets workbook id |
| `DEFAULT_TZ` | no | Default timezone, used by tools for date parsing (Europe/Moscow) |
| `LOG_LEVEL` | no | pino level |

Store secrets in `.env` (git-ignored). Commit `.env.example` with placeholders only.

---

## Roadmap

- **Sprint 1 (current):** scaffold + Telegram + Sheets + tasks. ← we are here
- **Sprint 2:** MAX adapter, Google Calendar, morning digest at 09:00.
- **Sprint 3:** Gmail (drafts, search, summarize); IMAP for corporate mail.
- **Sprint 4:** GitHub coupling (PR status, stuck reviews, CI failures).
- **Sprint 5:** CRM / 1С — spec depends on the specific systems.
- **Sprint 6:** proactive layer — alerts on deadlines, new leads, important mail.

---

*Last updated: 2026-05-11 — Sprint 1 caркас committed; integrations stubbed with `// TODO(muziai)` markers awaiting MuziAI patterns.*
