# Frontend Swarm Context - Rayu Web

This file maintains the current frontend status, design tokens, and integration details for the Rayu Web application.

## 1. Applied Design System (AGENTIX Theme)

### Color Tokens
- `--green`: `#00FF88` (Accent/Success)
- `--green-dim`: `#00cc6e` (Hover state)
- `--green-glow`: `rgba(0,255,136,0.18)`
- `--green-glow-btn`: `rgba(0,255,136,0.35)`
- `--red`: `#FF3366` (Error/Danger)
- `--bg`: `#030507` (Core background)
- `--bg2`: `#070b0f` (Secondary panels/cards)
- `--bg3`: `#0d1117` (Terminal widget/Header background)
- `--border`: `rgba(255,255,255,0.06)`
- `--border-bright`: `rgba(0,255,136,0.25)`
- `--text`: `#e0e8f0` (Primary readable text)
- `--muted`: `#4a5568` (Muted captions)

### Typography & Fonts
- **Orbitron** (wght: 400, 600, 700, 900) - For brand headings, pricing titles, and visual highlights.
- **DM Mono** (wght: 300, 400, 500) - For technical outputs, console blocks, and system badges.
- **Inter** (wght: 300, 400, 500, 600) - General interface text.

### Decorative Elements (body)
- **Grid Pattern**: Configured with CSS repeating linear-gradients on `body::before` (fixed, background size `60px 60px`).
- **Vignette Glow**: Two radial-gradients applied to `body::after` for top-center green and bottom-right red soft ambient glow.

---

## 2. Main Page Structures

### Header / Navigation
- Fixed height `64px`, backdrop blur `12px`, padding `0 48px`.
- Left: Logo `RAYU` in Orbitron 900 with breathing green dot logo mark.
- Center: Horizontal link list containing Plans, Terminal, and Docs. Links animate using custom sliding scaleX borders.
- Right: NextAuth sign-in/sign-out actions mapped to standard AGENTIX button states (`btn-ghost`, `btn-primary`).

### Landing Page (`app/page.tsx`)
- **Hero**: Splitted 2-column grid. Left side carries headings, main copywriting, social proof overlapping avatars and buttons. Right side features a custom terminal visual emulation of `rayu "fix the auth bug"` execution showing path readings, patch diffing, testing output, and completed state.
- **Stats**: Multi-cell container summarizing platform counts (models, uptime, MCP integrations).
- **Infinite Logo Ticker**: Continuously sliding track displaying providers (GPT, Claude, Gemini, Mistral, GitHub, Ollama, etc.).
- **Feature Matrix**: A responsive 3-column layout highlighting key features using customized glass cards.
- **CTA Footer Area**: A centered box inviting users to start with primary call-to-actions, followed by a semantic developer-centric footer.

### Plans & Catalog Page (`app/plans/page.tsx`)
- Server Component that sort, resolve, and render plans dynamically fetched from `/plans` API.
- Fully restyled card grids with custom pricing display and conditional button states mapped to standard tokens.

### Admin Dashboard (`app/admin/page.tsx`)
- Client Component managing search filters, provider statistics, and user control features (Activate, Suspend, Ban).
- Enhanced with responsive, beautifully structured system grids, search modules, custom state badges, and clean tabular rows.

---

## 3. Integration & Contract Guidelines
- **API Origin**: Managed dynamically through `lib/config` `apiUrl` functions.
- **Native Google OAuth + NextAuth**: Integrations in `layout.tsx` (SessionProvider) and `app/admin/AdminProvider.tsx` use `useSession()`/`useRayuToken()`. The Rayu access token (Bearer) is obtained via `POST /api/auth/oauth/google` and persisted in `localStorage`, with silent refresh via `/api/cli/refresh`.
- **TypeScript**: The entire application type-checks cleanly. Do not bypass compilers or skip standard typings on props.
