# Changelog

## 2.3.1

### Added

- A Settings tab (gear in the sidebar title bar, the Command Palette, or the Accounts
  menu) with General, Account, Integrations and About sections.
- Account details in the editor: profile, plan, credits, usage limits, this month's
  feature usage, and device management.
- A Rayu entry in VS Code's Accounts menu, and a credits status-bar item.
- Integrations: connect Telegram (shared bot by QR, or your own bot token), turn on
  Studio Remote or pair it with a QR code, and install Rayu's GitHub Actions workflows.
- Platform VSIX packages with a compiled engine and bundled ripgrep.
- A memory watchdog: an engine that reaches its limit is replaced, and the next message
  continues the same conversation.

### Changed

- The engine now starts in the permission mode you chose, so a
  `permissions.defaultMode` written for the terminal no longer overrides it.
- The Telegram connect panel moved from the chat into Settings → Integrations.
- Signing out of Rayucode clears the same caches as the CLI's `/logout` and keeps a
  configured API key.
- Icons are now VS Code codicons, and the panel's corner radii/focus/high-contrast
  styling follow the editor.

### Fixed

- A crashed engine's replacement resumes the same conversation instead of starting over.

## 1.6.23

- Initial release of Rayucode Visual Studio Code extension.
- Native sidebar panel with streaming chat transcript and permission controls.
- Interactive file change review card for keeping/undoing modifications with editor diffs.
- Slash-command autocomplete and workspace file @-mention popover.
- Context window usage metrics in panel header.
- Model Context Protocol (MCP) server status reporting.
- Shared authentication with the Rayu CLI.
