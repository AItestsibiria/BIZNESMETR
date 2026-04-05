# CLAUDE.md — AI Assistant Guide for BIZNESMETR

This file provides context and conventions for AI assistants (Claude Code and others) working in this repository.

---

## Project Overview

**BIZNESMETR / Acme API** is a business metrics REST API platform.

**Repository:** `aitestsibiria/biznesmetr`  
**Primary remote:** `origin`  
**Runtime:** Node.js 20  
**Stack:** Express · PostgreSQL · Prisma ORM · TypeScript (strict) · Jest · Zod

---

## Commands

```bash
npm run dev          # Start development server
npm run test         # Run tests (Jest)
npm run lint         # ESLint + Prettier check
npm run build        # Production build
npm run db:test:reset  # Reset local test DB — REQUIRED before running tests
```

---

## Architecture

- **Framework:** Express REST API
- **Database:** PostgreSQL accessed via Prisma ORM
- **Request handlers:** `src/handlers/` — one file per resource/route group
- **Shared types:** `src/types/` — TypeScript interfaces and Zod schemas shared across the app

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
- Never let raw Prisma errors, Zod errors, or Node errors propagate to the HTTP response body.
- Log the full error internally before sending the sanitized response.

---

## Testing

Tests use a **real local PostgreSQL database** — not mocks.

```bash
# Always reset the test DB before a test run
npm run db:test:reset
npm run test
```

- Test files live alongside source files or in a `__tests__/` subdirectory.
- Seed data and fixtures go through Prisma directly — no raw SQL in tests.
- Each test suite is responsible for cleaning up the data it creates.

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
- Never expose stack traces, Prisma error details, or internal paths to the client.
- Remove all unused imports — TypeScript strict mode will fail the build otherwise.
- Before suggesting tests pass, run `npm run db:test:reset` then `npm run test`.

### Security

- Never introduce command injection, SQL injection, XSS, or other OWASP Top 10 vulnerabilities.
- Use Prisma's parameterized queries — never string-interpolate user input into queries.
- Do not log secrets, tokens, passwords, or PII.

### Git Workflow for AI Assistants

- Develop on the designated feature branch (check task description or system prompt).
- Commit with descriptive messages following Conventional Commits format above.
- Push using `git push -u origin <branch-name>`.
- Do **not** create a pull request unless explicitly asked.
- Do **not** force-push or rebase published commits.

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `NODE_ENV` | Yes | `development`, `test`, or `production` |
| `DATABASE_URL` | Yes | Prisma connection string for the main DB |
| `TEST_DATABASE_URL` | Yes | Separate DB used by Jest — never the main DB |

Store secrets in `.env` (git-ignored). Commit `.env.example` with placeholder values only.

---

*Last updated: 2026-04-05 — Updated with Acme API stack, conventions, and testing requirements.*
