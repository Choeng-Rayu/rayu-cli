# Publishing a new version of Rayucode

Follow these steps every time you want to release a new version.

---

## 1. Make your changes

Edit the code in `packages/vscode/src`, `packages/core/src`, or `rayu/src` as needed.

---

## 2. Update the changelog

Open `CHANGELOG.md` and add a new entry at the top (above the previous version):

```markdown
## [0.1.1] — YYYY-MM-DD

### Added
- ...

### Fixed
- ...

### Changed
- ...
```

Only include the sections that apply. Use today's date.

---

## 3. Bump the version

From `rayucode/packages/vscode`:

```bash
cd /home/rayu/rayu/rayu-cli/rayucode/packages/vscode

npm version patch --no-git-tag-version   # 0.1.0 → 0.1.1  (bug fixes)
npm version minor --no-git-tag-version   # 0.1.0 → 0.2.0  (new features)
npm version major --no-git-tag-version   # 0.1.0 → 1.0.0  (breaking changes)
```

> **Note:** `npm version` runs an install step, which in this workspace tries to
> fetch `@rayu-dev/agent-protocol` and `@rayu-dev/web-bridge-client` from the public
> registry and fails with a 404. The version IS still written correctly and the
> hoisted workspace links at the repo root are unaffected — verify with
> `npm run build && npm run test` and carry on. To skip the install entirely:
> `npm version patch --no-git-tag-version --no-workspaces-update`.

**When to use which:**
| Change type | Command |
|---|---|
| Bug fix, small improvement | `patch` |
| New feature, backward compatible | `minor` |
| Breaking change | `major` |

---

## 4. Build everything

From the repo root (builds all dependencies in the correct order):

```bash
cd /home/rayu/rayu/rayu-cli
npm run build
```

If you only changed extension code (not `rayu/src`):

```bash
cd /home/rayu/rayu/rayu-cli/rayucode/packages/vscode
npm run build
```

---

## 5. Package the VSIX

```bash
cd /home/rayu/rayu/rayu-cli/rayucode/packages/vscode
npm run package
```

This produces `rayucode-<version>.vsix`. Verify it looks right:

```bash
npm run ls:package
```

Expected: **13 files, ~5.3 MB**.

---

## 6. Publish to VS Code Marketplace

```bash
npx vsce publish --packagePath rayucode-<version>.vsix
```

If your login has expired, re-authenticate first:

```bash
npx vsce login RayuCode
# paste your Azure DevOps PAT when prompted
```

**Where to get a new PAT** (if yours expired):
1. Go to [dev.azure.com](https://dev.azure.com)
2. Profile (top right) → **Personal access tokens** → **New Token**
3. Organization: **All accessible organizations**
4. Scope: **Marketplace → Manage**
5. Copy the token and paste it into `npx vsce login RayuCode`

---

## 7. Publish to Open VSX (optional)

For Cursor, VSCodium, and Gitpod users:

```bash
npx ovsx publish rayucode-<version>.vsix -p <your-open-vsx-token>
```

Get a token at [open-vsx.org](https://open-vsx.org) → sign in with GitHub → profile → **Access Tokens**.

---

## 8. Verify it's live

Check your publisher dashboard:
```
https://marketplace.visualstudio.com/manage/publishers/RayuCode
```

Once status shows **Published**, the new version is live at:
```
https://marketplace.visualstudio.com/items?itemName=RayuCode.rayucode
```

Test the install:
```bash
code --install-extension RayuCode.rayucode
```

---

## Quick reference — full release in one flow

```bash
# 1. from repo root — build everything
cd /home/rayu/rayu/rayu-cli && npm run build

# 2. bump version, package, and publish
cd rayucode/packages/vscode
npm version patch --no-git-tag-version
npm run package
npx vsce publish --packagePath rayucode-$(node -p "require('./package.json').version").vsix
```
