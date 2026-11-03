# GitHub integration

RayuCode can respond to trusted `@rayu` requests and review pull requests using
GitHub Actions. The first release uses the repository's job-scoped
`GITHUB_TOKEN`; the GitHub App private key is not uploaded to repositories and
is not required by the Action.

## Install

1. Install and authenticate GitHub CLI:

   ```bash
   gh auth login
   gh auth refresh -h github.com -s repo,workflow
   ```

2. Start Rayu in a repository and run:

   ```text
   /install-github-app
   ```

3. Select the assistant workflow, review workflow, or both. Rayu stores the API
   key as the `RAYU_API_KEY` Actions secret and opens a pull request containing
   the selected workflow files.

4. Review and merge the setup pull request.

## Modes and permissions

- **Assistant:** trusted owners, members, and collaborators can mention `@rayu`
  in issues and pull-request comments. The workflow may write repository
  contents and comments. Issue requests are published on a new branch and pull
  request; PR requests update only a same-repository PR branch.
- **Review:** automatically reviews trusted, non-draft, same-repository pull
  requests. It has read-only source access and may post PR comments.

The Action strips the Rayu API key and GitHub token from agent subprocesses,
does not persist checkout credentials, and refuses automated edits to workflow,
Action, and submodule configuration files.

## GitHub App configuration

For the Actions-based release, configure the RayuCode Agentic GitHub App with
only the automatically granted **Metadata: read-only** permission. OAuth,
Device Flow, and webhooks remain disabled. The App's PEM private key is reserved
for a future server-side integration and must never be committed or added to a
client build.
