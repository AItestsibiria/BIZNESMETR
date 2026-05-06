# CLAUDE.md — AI Assistant Guide for BIZNESMETR

This file provides context and conventions for AI assistants (Claude Code and others) working in this repository.

---

## Project Overview

**BIZNESMETR / Acme API** is a business metrics REST API platform — implementation host for the **MUZIAI v304** strategy (`podaripesnu.ru`).

**Repository:** `aitestsibiria/biznesmetr`  
**Primary remote:** `origin`  
**Runtime:** Node.js 20 LTS (verify on VPS1 — see `docs/strategy/PREFLIGHT.md`)  
**Stack:** Express · **SQLite** (`data.db`) · **Drizzle ORM** · TypeScript (strict) · Vitest · Zod  
**Note on stack:** PostgreSQL migration is planned for v305–v306 (see `docs/strategy/ANSWERS.md` §16). Until then, SQLite is the only DB.

---

## Strategy Package — MUZIAI v304 (READ FIRST)

The repository hosts the implementation of the **MUZIAI v304** strategy for `podaripesnu.ru`. The full strategic specification — architecture, plugin API, event catalog, full DB DDL, 8-sprint roadmap, deployment scripts — lives in `docs/strategy/`.

**Before writing any new code, read at least:**

1. `docs/strategy/README.md` — index and quick navigation
2. `docs/strategy/original/00-NAVIGATOR-объединённая-стратегия.md` — system map
3. `docs/strategy/original/06-PLUGIN-АРХИТЕКТУРА-ХВОСТЫ.md` — Module API, Event Bus, Hook Points (foundation for all new features)
4. `docs/strategy/original/07-DEPLOY-ROADMAP-СХЕМА-БД.md` — full DB schema, 8-sprint plan, one-command deploy

### Non-negotiable architectural rules

| Rule | What it means in code |
|---|---|
| **Thin core + plugins** | All new features live in `plugins/<name>/`. Never modify core (`auth`, `billing`, `generations`, `streaming`, `payments`, `playlist`, `admin`, `diagnostics`) except for critical bug fixes. |
| **Event-driven** | Plugins publish/subscribe through the `EventBus` — no direct cross-plugin calls. Standard event names live in `06 §2.3`. |
| **Plugin owns its tables** | Each plugin ships its own SQL migration; core schema is off-limits except for the additive ALTERs listed in `07 §3`. |
| **Feature flags by default** | New behavior gates on `feature_flags` so it can be toggled without a release. |
| **No vendor lock** | Suno via GPTunnel and Robokassa sit behind abstractions — keep that boundary. |

### Operational constraints

- **🚨 Single-VPS topology, three instances:** the host `72.56.1.149` runs:
  - `podaripesnu.ru` — **production #1** (live, selling) — DO NOT TOUCH
  - `muziai.ru` — **production #2** (live, selling) — DO NOT TOUCH
  - `clone.muziai.ru` — **staging** with a copy of prod data — this is the only place v304 code runs during development
  - Three apps, three paths, three pm2 processes — one machine. Any unscoped command can hit either prod. Always pin commands to the clone path (e.g. `/var/www/muziai-clone/`) — exact path comes from the §2 SSH audit.
- **Cutover flow:** all v304 changes land on clone first → smoke + integration tests → Eugene approves → roll to `podaripesnu.ru` → roll to `muziai.ru`. Each prod cutover gets its own five-level warning, ручной DB snapshot, and rollback rehearsal.
- **All UI text, logs, emails, and docs are in Russian.**
- The 25 blocker questions from `07 §4` are now answered — see `docs/strategy/ANSWERS.md`. Pre-Sprint 1 / 6 / 7 checklists in `docs/strategy/PREFLIGHT.md`.

### Sprint roadmap (≈2.5 months, 1 dev)

S1 foundations · S2 Suno @ 100% · S3 Persona/Extend/Cover · S4-5 nine agents · S6 chatbot · S7 dashboard + ads · S8 hardening. Detail in `07 §2`.

> ⚠️ The CLAUDE.md sections below describe the local Acme API conventions that apply to **how** we write code in this repo (Express, Drizzle, Zod, etc.). The strategy package describes **what** we build. Follow both.

---

## Commands

```bash
npm run dev             # Start development server
npm run test            # Run tests (Vitest)
npm run test:smoke      # Smoke tests only (target: < 10 min)
npm run lint            # ESLint + Prettier check
npm run build           # Production build
npm run db:migrate      # Apply Drizzle migrations to data.db
npm run db:test:reset   # Recreate test SQLite DB and apply migrations
```

---

## Architecture

- **Framework:** Express REST API
- **Database:** SQLite (`data.db`) accessed via **Drizzle ORM**. Migrations live in `drizzle/migrations/`; per-plugin migrations in `plugins/<name>/migrations/`.
- **Request handlers:** `src/handlers/` (core) and `plugins/<name>/routes.ts` (plugins) — one file per resource / route group
- **Shared types:** `src/types/` — TypeScript interfaces and Zod schemas shared across the app
- **Plugin runtime:** Module API (see `docs/strategy/original/06-PLUGIN-АРХИТЕКТУРА-ХВОСТЫ.md`) — every new feature is a plugin with its own `module.ts`, migrations, routes, jobs, event subscriptions
- **Eventing:** in-process `EventBus` with persisted events in the `events` table

### Response Shape

Every endpoint returns the same envelope — no exceptions:

```ts
{ data: T | null, error: string | null }
```

Never break this shape. On success, set `data` and leave `error` null. On failure, set `error` and leave `data` null. Never expose stack traces or internal error messages to the client.

---

## Conventions

### Validation

Use **Zod** for all request body and query-param validation. Define schemas in `src/types/` when they are shared; colocate them in the handler file when they are route-specific.

```ts
import { z } from 'zod'

const CreateWidgetSchema = z.object({
  name: z.string().min(1),
  value: z.number().positive(),
})
```

Parse at the handler boundary before any business logic runs.

### Logging

Use the **`logger` module** — never `console.log`, `console.error`, etc.

```ts
import { logger } from '../logger'

logger.info('Widget created', { widgetId })
logger.error('Failed to create widget', { error })
```

### TypeScript

- **Strict mode is on.** The compiler will reject unused imports — remove them.
- Do not use `any`. Use `unknown` and narrow with type guards or Zod `.parse()`.
- Do not silence TypeScript errors with `// @ts-ignore` or `// @ts-expect-error` without a comment explaining why.

### Error Handling

- Catch errors at the handler level; return `{ data: null, error: 'Human-readable message' }`.
- Never let raw Drizzle errors, Zod errors, or Node errors propagate to the HTTP response body.
- Log the full error internally before sending the sanitized response.

---

## Testing

Tests use a **real local SQLite database** — not mocks.

```bash
# Always reset the test DB before a test run
npm run db:test:reset
npm run test
```

- Test files live alongside source files or in a `__tests__/` subdirectory (per file 06 §6.1, plugins keep their tests in `plugins/<name>/__tests__/`).
- Seed data and fixtures go through Drizzle directly — no raw SQL in tests except for `PRAGMA` statements.
- Each test suite is responsible for cleaning up the data it creates.
- `PRAGMA integrity_check` is part of smoke tests.

---

## Branch Conventions

| Pattern | Purpose |
|---|---|
| `main` | Stable, production-ready code |
| `develop` | Integration branch for features |
| `feature/<description>` | New features |
| `fix/<description>` | Bug fixes |
| `claude/<description>-<id>` | Branches created by Claude Code (auto-generated) |

Claude Code branches follow the pattern `claude/<short-description>-<random-suffix>`, e.g. `claude/add-claude-documentation-GOqfS`.

**Never push directly to `main`.** All changes go through pull requests.

---

## Commit Message Convention

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short summary>

[optional body]

[optional footer]
```

Common types: `feat`, `fix`, `refactor`, `test`, `docs`, `chore`

Examples:
```
feat(handlers): add GET /widgets endpoint with pagination
fix(auth): handle expired token refresh correctly
test(handlers): add coverage for widget creation errors
```

---

## For AI Assistants

### Before Making Changes

1. **Read the relevant files first.** Never edit code you haven't read.
2. **Follow existing patterns.** Check nearby handlers for how validation, logging, and responses are structured before writing new code.
3. **Scope changes to what was asked.** Do not refactor surrounding code, add docstrings, or clean up unrelated areas.

### Critical Rules

- Always use the `logger` module — never `console.log`.
- Always validate request input with Zod before touching business logic.
- Always return `{ data, error }` — never a bare object or array.
- Never expose stack traces, Drizzle error details, or internal paths to the client.
- Remove all unused imports — TypeScript strict mode will fail the build otherwise.
- Before suggesting tests pass, run `npm run db:test:reset` then `npm run test`.
- New features go into `plugins/<name>/` — never modify core directly except for fixes listed in `docs/strategy/original/01-АУДИТ-И-АРХИТЕКТУРА.md`.

### Security

- Never introduce command injection, SQL injection, XSS, or other OWASP Top 10 vulnerabilities.
- Use Drizzle's parameterized queries — never string-interpolate user input into queries.
- Do not log secrets, tokens, passwords, or PII. Logger has a redaction layer (Sprint 8).
- Do not commit secrets to the repo. `.env` is git-ignored. **Do not paste secrets into chats / PRs / commits — even encrypted blobs.** Eugene installs secrets directly into VPS1 `.env` over SSH.

### Git Workflow for AI Assistants

- Develop on the designated feature branch (check task description or system prompt).
- Commit with descriptive messages following Conventional Commits format above.
- Push using `git push -u origin <branch-name>`.
- Do **not** create a pull request unless explicitly asked.
- Do **not** force-push or rebase published commits.

---

## Environment Variables

Full list lives in `docs/strategy/original/07-DEPLOY-ROADMAP-СХЕМА-БД.md` §1.6 (`.env.example`). Minimum to boot:

| Variable | Required | Description |
|---|---|---|
| `NODE_ENV` | Yes | `development`, `test`, or `production` |
| `DATABASE_URL` | Yes | SQLite path, e.g. `file:./data.db` |
| `TEST_DATABASE_URL` | Yes | Separate SQLite path for Vitest, e.g. `file:./data.test.db` |
| `SESSION_SECRET` | Yes | 32-byte random for signed cookies |
| `SIGNED_URL_SECRET` | Yes | 32-byte random for streaming signatures |
| `GPTUNNEL_API_KEY` | Yes (S2+) | Suno via GPTunnel |
| `ROBOKASSA_LOGIN` / `_PASSWORD_1` / `_PASSWORD_2` | Yes (S3+) | Payments |
| `SMTP_*` / `IMAP_*` | Yes (S6) | Email hub |
| `TELEGRAM_BOT_TOKEN` | Yes (S6) | TG channel |
| `VK_GROUP_ID` / `VK_ACCESS_TOKEN` / `VK_CONFIRMATION_CODE` / `VK_SECRET` | Yes (S6) | VK channel |
| `YM_COUNTER_ID` / `VK_PIXEL_ID` | Yes (S1) | Pixels |
| `LLM_PROVIDER` / `LLM_MODEL` | Yes (S6) | ConductorBot LLM |

Store secrets in `.env` (git-ignored). Commit `.env.example` with placeholder values only. **Do not transmit secrets through the chat — Eugene puts them on VPS1 directly over SSH.**

---

*Last updated: 2026-05-06 — Stack corrected to SQLite + Drizzle + Vitest (per `ANSWERS.md` §16). 25 v304 blocker questions answered; pre-sprint checklists in `docs/strategy/PREFLIGHT.md`.*
