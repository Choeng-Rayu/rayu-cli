## Authentication Design

*Not applicable* – these commands are local CLI utilities and do not perform authentication themselves. Authentication is handled elsewhere (e.g., `src/utils/auth.ts`).

## Authorization Matrix (RBAC)

- No direct resource access; commands only generate prompts for the LLM. No RBAC checks are required in these files.

## Input Validation Rules

- **ultraplan** (`src/commands/ultraplan-local/index.ts`): Accepts a free‑form task description (`args`). No validation is performed because the value is only interpolated into a prompt text; there is no downstream command execution.
- **ultrareview** (`src/commands/ultrareview-local/index.ts`): Accepts an optional PR number (`args`). The argument is trimmed and interpolated into a markdown code‑block for display only. No numeric validation is performed, but this does not affect security because the value is *not* executed.
- **thinking** (`src/utils/thinking.ts`): Reads environment variables (`USER_TYPE`, `MAX_THINKING_TOKENS`) and config settings; values are used only for feature‑gate decisions.

## Sensitive Fields (hash/encrypt)

- No handling of secrets, API keys, or passwords in the examined files. All environment variables accessed are feature flags, not credentials.

## OWASP Top 10 Checklist + Security Headers

| OWASP Category | Findings |
|----------------|----------|
| A1 – Injection | No direct command or SQL injection vectors. User‑provided arguments are only inserted into prompt strings; they are never passed to a shell, DB, or eval.
| A2 – Broken Auth | Not relevant for these files.
| A3 – Sensitive Data Exposure | No secrets are read or logged.
| A4 – XML External Entity | Not applicable (no XML handling).
| A5 – Broken Access Control | No resource‑level access performed.
| A6 – Security Misconfiguration | No insecure defaults identified.
| A7 – Cross‑Site Scripting | Not applicable (CLI only).
| A8 – Insecure Deserialization | No deserialization.
| A9 – Using Components with Known Vulnerabilities | Not assessed here; rely on dependency management.
| A10 – Insufficient Logging & Monitoring | No logging of user‑provided input; prompts are passed to LLM without sanitisation, which is acceptable for this layer.

**Overall Verdict**: The three changed files do not introduce command‑injection, unsafe subprocess execution, or secret leakage. Input handling is limited to prompt generation, which is safe given the current architecture.
