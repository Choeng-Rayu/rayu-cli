# Contributing to RAYU CLI

Thank you for your interest in contributing to RAYU CLI! This document provides guidelines and instructions for contributing to the project.

## Code of Conduct

This project adheres to a Code of Conduct that all contributors are expected to follow. Please read [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) before contributing.

## Getting Started

### Prerequisites

- **Bun** >= 1.0 (for CLI development)
- **Node.js** >= 18.0 (for backend/web development)
- **Go** >= 1.24 (for gateway development)
- **Docker** and **Docker Compose** (for full stack development)

### Repository Structure

This is a monorepo containing four independent projects:

- `rayu/` — CLI (TypeScript + Bun + React/Ink)
- `rayu-backend/` — Backend API (NestJS + Prisma + MySQL)
- `rayu-gateway/` — AI Gateway (Go + chi + Redis)
- `rayu-web/` — Marketing/Dashboard (Next.js 15 + Clerk)
- `deploy/` — Production deployment (Docker Compose + Caddy)

### Setting Up Development Environment

#### CLI Development

```bash
cd rayu
bun install
bun run dev              # run from source
bun run typecheck        # type check
bun test                 # run tests
```

#### Backend Development

```bash
cd rayu-backend
npm install
npm run start:dev        # NestJS watch mode
npm run test             # run tests
```

#### Gateway Development

```bash
cd rayu-gateway
cp .env.example .env     # configure environment
go run ./cmd/gateway     # run dev server
go test ./...            # run tests
```

#### Web Development

```bash
cd rayu-web
npm install
npm run dev              # Next.js dev server
npm run test             # run tests
```

## How to Contribute

### Reporting Bugs

If you find a bug, please create an issue on GitHub with:

- **Clear title** describing the issue
- **Steps to reproduce** the bug
- **Expected behavior** vs actual behavior
- **Environment details** (OS, Bun/Node version, RAYU version)
- **Error messages** or logs if applicable

### Suggesting Features

Feature requests are welcome! Please:

- Check existing issues to avoid duplicates
- Clearly describe the feature and its use case
- Explain why this feature would be valuable
- Consider providing implementation ideas

### Pull Requests

#### Before Starting Work

1. **Check existing issues** — avoid duplicate work
2. **Create an issue** if one doesn't exist for your contribution
3. **Discuss major changes** with maintainers before starting
4. **Read RAYU.md and AGENTS.md** in the `rayu/` directory for CLI development

#### Development Workflow

1. **Fork the repository** and create a branch from `dev`
2. **Make your changes** following the coding standards below
3. **Write or update tests** — 80%+ coverage required
4. **Run the test suite** — ensure all tests pass
5. **Run type checking** — ensure no TypeScript errors
6. **Write a clear commit message** — follow conventional commits
7. **Submit a pull request** to the `dev` branch

#### Commit Message Format

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Types:**
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `refactor`: Code refactoring
- `test`: Test additions or modifications
- `chore`: Build process or auxiliary tool changes
- `perf`: Performance improvements
- `ci`: CI/CD changes

**Examples:**
```
feat(cli): add image generation tool
fix(backend): resolve JWT validation error
docs(readme): update installation instructions
refactor(gateway): simplify rate limiter logic
```

#### Code Style

**TypeScript/JavaScript:**
- Use TypeScript for all new code
- Follow existing code style (2 spaces, single quotes)
- Use ESLint and Prettier (configuration in project)
- Avoid `any` types — use proper typing
- Use functional programming patterns where appropriate

**Go:**
- Follow standard Go conventions
- Run `gofmt` before committing
- Use meaningful variable names
- Add godoc comments for exported functions

**General:**
- Keep functions small and focused (<50 lines)
- Write self-documenting code with clear names
- Add comments only where logic isn't obvious
- No console.log in production code

#### Testing Requirements

- **CLI:** 80%+ test coverage required
- **Backend:** Unit tests for business logic, E2E for API endpoints
- **Gateway:** Unit tests for core logic, integration tests for critical paths
- **Web:** Component tests for UI, E2E for critical user flows

Run tests before submitting:
```bash
# CLI
cd rayu && bun test

# Backend
cd rayu-backend && npm run test && npm run test:e2e

# Gateway
cd rayu-gateway && go test ./...

# Web
cd rayu-web && npm run test
```

#### Documentation

- Update README.md if adding user-facing features
- Update RAYU.md if changing CLI architecture
- Add JSDoc/godoc comments for public APIs
- Update relevant documentation in `rayu/documentations/` for CLI features

## CLI Development Guidelines

**Critical rules for CLI development** (see `rayu/RAYU.md` and `rayu/AGENTS.md`):

### Rule 1: No Assumptions
- Always read the source code — never assume behavior
- This is a Claude Code fork with significant modifications
- File names don't tell the full story — read the implementation

### Rule 2: Prevent Duplicate Code
- Before adding ANY new feature, search for existing implementations
- Use `/graphify` to explore the codebase
- Check these locations:
  - `rayu/src/commands/` — 94+ commands
  - `rayu/src/tools/` — 48+ tools
  - `rayu/src/utils/` — 354+ utility files
  - `rayu/src/components/` — 145+ UI components
  - `rayu/src/skills/bundled/` — 20+ bundled skills

### Rule 3: Use Graphify
- Run `/graphify --mode deep` before starting work
- Discover relationships and dependencies
- Verify functionality doesn't already exist

### Rule 4: Follow Conventions
- Feature flags: `feature('FLAG')` is compile-time DCE
- Commands: Register in `src/commands.ts`
- Tools: Register in `src/tools.ts`
- Skills: Define in `src/skills/bundled/` with SKILL.md
- React/Ink: Custom reconciler, not standard npm `ink`

### Rule 5: Build & Test
```bash
bun install
bun run dev              # test changes
bun run build            # verify bundle
bun test                 # run test suite
bun run typecheck        # type check
```

## Review Process

1. **Automated checks** must pass (tests, linting, type checking)
2. **Code review** by at least one maintainer
3. **Testing** by maintainers if needed
4. **Approval** and merge to `dev` branch
5. **Release** from `dev` to `main` periodically

## Getting Help

- **Documentation:** Check README.md and files in `rayu/documentations/`
- **Issues:** Browse existing issues or create a new one
- **Discussions:** Use GitHub Discussions for questions
- **Code:** Read RAYU.md and AGENTS.md for architecture details

## License

By contributing to RAYU CLI, you agree that your contributions will be licensed under the MIT License.

---

**Thank you for contributing to RAYU CLI!** Your contributions help make this project better for everyone.
