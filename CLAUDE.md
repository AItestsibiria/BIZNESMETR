# CLAUDE.md — AI Assistant Guide for BIZNESMETR

This file provides context and conventions for AI assistants (Claude Code and others) working in this repository.

---

## Project Overview

**BIZNESMETR** is a business metrics platform. This file will be updated as the codebase evolves. If you are reading this as an AI assistant, check the current state of the repository (files, directories, package manifests) before making assumptions about the tech stack — this document reflects what is known at the time of last update.

**Repository:** `aitestsibiria/biznesmetr`  
**Primary remote:** `origin`

---

## Repository State

This repository was initialized fresh. As the codebase grows, this section should be updated with:

- Technology stack (languages, frameworks, runtime versions)
- Directory layout and purpose of each top-level folder
- Entry points (e.g., `src/index.ts`, `main.py`, `cmd/server/main.go`)
- Database / storage engines in use
- External service integrations

---

## Branch Conventions

| Pattern | Purpose |
|---|---|
| `main` | Stable production-ready code |
| `develop` | Integration branch for features |
| `feature/<description>` | New features |
| `fix/<description>` | Bug fixes |
| `claude/<description>-<id>` | Branches created by Claude Code (auto-generated) |

Claude Code branches follow the pattern `claude/<short-description>-<random-suffix>`, e.g. `claude/add-claude-documentation-GOqfS`.

**Never push directly to `main`.** All changes go through pull requests.

---

## Development Workflow

### Getting Started

```bash
# Clone the repo
git clone <remote-url>
cd BIZNESMETR

# Install dependencies (update this command once a package manager is chosen)
# npm install  / pip install -r requirements.txt / go mod download / etc.

# Copy environment template
cp .env.example .env
# Fill in required values before running
```

### Running the Project

> Update this section once the project has a defined start command.

```bash
# Development server
# npm run dev / python main.py / go run ./cmd/server

# Production build
# npm run build / python -m build / go build ./...
```

### Running Tests

> Update once a test framework is configured.

```bash
# Run all tests
# npm test / pytest / go test ./...

# Run with coverage
# npm run test:coverage / pytest --cov / go test -cover ./...
```

### Linting and Formatting

> Update once linters are configured.

```bash
# Lint
# npm run lint / ruff check . / golangci-lint run

# Format
# npm run format / ruff format . / gofmt -w .
```

---

## Commit Message Convention

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short summary>

[optional body]

[optional footer]
```

Common types:
- `feat` — new feature
- `fix` — bug fix
- `refactor` — code change that neither fixes a bug nor adds a feature
- `test` — adding or fixing tests
- `docs` — documentation only changes
- `chore` — build process, dependency updates, tooling

Examples:
```
feat(dashboard): add revenue trend chart
fix(auth): handle expired token refresh correctly
docs: update CLAUDE.md with stack details
```

---

## For AI Assistants

### Before Making Changes

1. **Read the relevant files first.** Never edit code you haven't read.
2. **Check for existing patterns.** Follow the conventions already established in the codebase before introducing new abstractions.
3. **Scope changes to what was asked.** Do not refactor surrounding code, add docstrings, or clean up unrelated areas unless explicitly requested.

### Code Quality Rules

- Do not add error handling, fallbacks, or validation for scenarios that cannot occur.
- Do not create helpers or abstractions for one-time operations.
- Do not introduce backwards-compatibility shims for removed code.
- Do not add comments to self-evident code.
- Trust internal framework guarantees; validate only at system boundaries (user input, external APIs).

### Security

- Never introduce command injection, SQL injection, XSS, or other OWASP Top 10 vulnerabilities.
- Do not log secrets, tokens, or personally identifiable information.
- Validate and sanitize all data that crosses system trust boundaries.

### Git Workflow for AI Assistants

- Develop on the designated feature branch (check task description or system prompt).
- Commit with descriptive messages following the Conventional Commits format above.
- Push using `git push -u origin <branch-name>`.
- Do **not** create a pull request unless explicitly asked.
- Do **not** force-push or rebase published commits.

### What to Update in This File

When significant project milestones are reached, update the relevant sections:
- New technology added → update **Repository State** and **Getting Started**
- New linter/formatter → update **Linting and Formatting**
- New test framework → update **Running Tests**
- New architectural patterns established → add an **Architecture** section
- New environment variables required → document them here or reference `.env.example`

---

## Environment Variables

> Populate this section once environment variables are defined.

| Variable | Required | Description |
|---|---|---|
| `NODE_ENV` / `APP_ENV` | Yes | Runtime environment (`development`, `production`) |
| *(add more as defined)* | | |

Store secrets in `.env` (git-ignored). Never commit `.env` to the repository. Commit `.env.example` with placeholder values.

---

## Architecture Notes

> This section will be filled in as the system design is established.

Key questions to answer here once the architecture is defined:
- What is the high-level system diagram? (services, databases, queues)
- Where does business logic live?
- How is authentication/authorization handled?
- How are database migrations managed?
- How is deployment triggered and to what environments?

---

*Last updated: 2026-04-05 — Initial creation on empty repository.*
