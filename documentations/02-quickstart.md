# 2. Quickstart

## First run (interactive)

Start Rayu-CLI in interactive mode by typing:

```bash
# If installed globally:
rayu

# Or run on-the-fly using npx:
npx @rayu-dev/rayu-cli
```

On first launch you'll go through a short setup:

1. **Theme** — pick a color theme.
2. **Provider setup** — choose a provider (Anthropic, NVIDIA, DeepSeek,
   Kimi/Moonshot, Doubleword, OpenAI, OpenRouter, or a local endpoint) and paste
   your **API key**. For local/custom endpoints you also enter a base URL and a
   default model.
3. **Trust** — confirm you trust the current working directory (Rayu can read,
   edit, and run files there).

Rayu then fetches the provider's model list and drops you into the chat REPL.

> Already have your key in a `.env` file? Rayu auto-imports known keys on
> startup — see [Providers](./03-providers.md#auto-import-from-env).

## Your first conversation

Type a prompt and press Enter:

```
> explain what this project does and list its main modules
```

Useful in-session commands (type `/` to see all):

| Command | Action |
|---------|--------|
| `/connect` | Add or switch to another provider |
| `/model` | Search & switch model (across all connected providers) |
| `/help` | List all slash commands |
| `/context` | Show context-window usage |
| `/cost` | Show token usage / cost for the session |
| `/clear` | Start a fresh conversation |
| `/exit` | Quit |

Press `Esc` to cancel a running turn; `Ctrl+C` twice to exit.

## Headless / scripted use (print mode)

Run a single prompt and print the result (no TUI):

```bash
# If installed globally:
rayu --print "write a one-line summary of package.json"

# Or using npx:
npx @rayu-dev/rayu-cli --print "write a one-line summary of package.json"
```

With explicit provider + model (no saved config needed):

```bash
RAYU_OPENAI_COMPATIBLE=1 \
RAYU_OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1 \
RAYU_OPENAI_API_KEY=nvapi-xxxxx \
rayu --print --model meta/llama-3.3-70b-instruct "summarize this repo"
# (or prepend npx @rayu-dev/rayu-cli instead of rayu)
```

JSON output for scripts:

```bash
rayu --print --output-format json "list top-level modules"
```

Auto-approve tool use (sandboxes/CI only — see security note in
[CLI Reference](./06-cli-reference.md)):

```bash
rayu --print --permission-mode bypassPermissions "read README and summarize"
```

## 💡 Writing Effective Prompts for Rayu

Because Rayu is an autonomous agent with file-system, terminal, and code-editing capabilities, prompting it is different from prompting a standard web chat model. Follow these strategies to get the best, most accurate results:

### 1. Be Specific About Files & Functions
Instead of asking a generic question, tell Rayu exactly where to look. This saves tokens, avoids unnecessary file searching, and ensures Rayu reads the correct context.
* ❌ *Bad:* "How is auth handled?"
*  *Good:* "Read `src/utils/auth.ts` and explain how session token validation works."
* ❌ *Bad:* "Fix the bug in the config."
*  *Good:* "Check the `loadConfig` function in `src/utils/config.ts`. It seems to return `undefined` when the environment variable is missing. Please add a fallback."

### 2. Guide the Verification Process
Rayu can execute terminal commands (with your permission). Ask it to verify its changes so it doesn't leave you with syntax or compilation errors.
*  *Good:* "Refactor the interface in `src/types/index.ts` to add a `role` field, then run `bun run typecheck` to verify that everything still compiles correctly."

### 3. Specify Design Constraints & Avoid Speculative Code
Let Rayu know if you want to keep the implementation simple. This prevents it from adding unnecessary helpers, excessive error handling, or speculative abstractions.
*  *Good:* "Implement a simple in-memory cache for user sessions in `src/utils/cache.ts`. Do not design for hypothetical future database synchronization. Keep it minimal and clean."

### 4. Provide Concrete Examples & Formats
If you need output in a specific format, or want to write code matching a certain pattern, include it in the prompt.
*  *Good:* "Write a unit test for `isTokenExpired` in `src/utils/auth.test.ts`. Follow the existing Jest table-driven test pattern used in other test files."

---

## 📋 Recommended Prompt Templates

Here are copy-pasteable prompt templates for common software engineering tasks:

### 🔍 Expline & Research:
```
Read `src/entrypoints/cli.tsx` and trace how command line arguments are parsed. List the files that are imported during this process and explain how `--print` mode is triggered.
```

### 🐛 Bug Fixing:
```
I am getting a null-pointer error when running the app. The stack trace points to `src/main.tsx` line 124. Read that file, diagnose the root cause, propose a fix, and run `bun test` to ensure tests still pass.
```

### ⚙️ Refactoring & Upgrading:
```
Refactor `src/utils/config.ts` to replace the deprecated config keys with the new ones defined in `package.json`. Make sure to update the type definitions as well, and run `tsc --noEmit` to verify.
```

### 🧪 Writing Tests:
```
Check `src/utils/config.ts`. Write comprehensive unit tests under `test/config.test.ts` covering both the happy path (all env vars set) and edge cases (missing optional vars, malformed JSON).
```

---

## 🧠 Persistent Workspace Rules (`RAYU.md`)

You can teach Rayu about your codebase's conventions so you don't have to repeat them in every prompt. Rayu-CLI automatically reads workspace instructions and rules upon starting from:
1. **`RAYU.md`** — Project instructions and style guide checked into your git repository.
2. **`RAYU.local.md`** — Your private, gitignored project instructions.
3. **`.rayu/rules/*.md`** — Conditioned/scoped instruction files (e.g. matching specific glob patterns).

### Example `RAYU.md` layout:
```markdown
# Project Instructions (RAYU.md)

## Build & Test Commands
- Install dependencies: `bun install`
- Build project: `bun run build`
- Typecheck: `bun run typecheck`
- Run all tests: `bun test`
- Run single test: `bun test test/path/to/test.test.ts`

## Code Style & Conventions
- Use TypeScript for all new code.
- Prefer `const` over `let`. Use explicit typing for function signatures.
- Keep components small and modular.
- Do not add comments for self-evident code; write clean and expressive variable names.
```

When these files are present, Rayu-CLI automatically reads them and refers to them to understand how to build, test, and style code in your repository!

---

## Pick a *chat* model

When choosing a model, prefer instruction/chat models
(e.g. `meta/llama-3.3-70b-instruct`, `deepseek-chat`, `deepseek-ai/deepseek-v4-pro`).
Base/code/embedding/OCR models (`codegemma`, `*-embedding`, `*-ocr`, `starcoder`)
are not chat models and will return `404` on the chat endpoint. See
[Troubleshooting](./10-troubleshooting.md#api-error-404).

Next: [Providers →](./03-providers.md)
