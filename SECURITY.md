# Security Policy

## Supported Versions

We release patches for security vulnerabilities in the following versions:

| Version | Supported          |
| ------- | ------------------ |
| 1.4.x   | :white_check_mark: |
| < 1.4   | :x:                |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

If you discover a security vulnerability in RAYU CLI, please report it privately:

### How to Report

1. **Email:** Send details to choengrayu307@gmail.com
2. **GitHub Security Advisory:** Use GitHub's [private vulnerability reporting](https://github.com/Choeng-Rayu/rayu-cli/security/advisories/new)

### What to Include

Please include as much of the following information as possible:

- Type of vulnerability (e.g., RCE, injection, authentication bypass)
- Full paths of source file(s) related to the vulnerability
- Location of the affected source code (tag/branch/commit)
- Step-by-step instructions to reproduce the issue
- Proof-of-concept or exploit code (if possible)
- Impact of the vulnerability

### Response Timeline

- **Initial response:** Within 48 hours
- **Status update:** Within 7 days
- **Fix timeline:** Depends on severity and complexity

### Disclosure Policy

- Security advisories will be published after a fix is released
- We follow coordinated disclosure practices
- Credit will be given to reporters (unless anonymity is requested)

## Security Best Practices

### For Users

- **Keep RAYU updated** to the latest version
- **Review permissions** before approving tool calls
- **Use API keys securely** — never commit keys to repositories
- **Enable 2FA** on your provider accounts (Anthropic, OpenAI, etc.)
- **Audit MCP servers** before connecting them

### For Contributors

- **Never commit secrets** — use environment variables
- **Validate all inputs** — prevent injection attacks
- **Use parameterized queries** — avoid SQL injection
- **Sanitize file paths** — prevent directory traversal
- **Review dependencies** — check for known vulnerabilities
- **Follow secure coding** practices in CONTRIBUTING.md

## Known Security Considerations

### API Keys
- RAYU stores API keys in `~/.rayu/config.json` with file permissions 600
- Keys are never sent to RAYU servers (except when using rayu-gateway)
- Review key storage in `src/utils/secureStorage/`

### Command Execution
- Bash tool executes shell commands — use with caution
- Permission system gates dangerous operations
- Review execution logic in `src/tools/Bash/`

### MCP Servers
- MCP servers run with full CLI privileges
- Only connect trusted MCP servers
- Review MCP integration in `src/services/mcp/`

### File Operations
- File operations respect permission boundaries
- Directory traversal protection in place
- Review file tools in `src/tools/`

## Security Updates

Security updates will be released as patch versions and announced via:

- GitHub Security Advisories
- Release notes
- Repository README.md

## Bug Bounty Program

We currently do not have a bug bounty program, but we deeply appreciate security researchers who responsibly disclose vulnerabilities.

---

Thank you for helping keep RAYU CLI and our users safe!
