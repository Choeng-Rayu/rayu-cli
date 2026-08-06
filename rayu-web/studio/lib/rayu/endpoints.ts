/**
 * Where every bolt.diy API path went.
 *
 * bolt.diy shipped 36 Remix server routes alongside its UI. Rayu Studio is a
 * pure frontend, so each of those either moved to rayu-backend, moved to
 * rayu-gateway, or was deleted. This file is the executable form of that
 * decision — one place to check what a given bolt endpoint became.
 *
 *   LLM + models      -> rayu-gateway  (see gatewayClient.ts)
 *   everything else    -> rayu-backend  (see backendClient.ts)
 *   host introspection -> deleted
 */

/** rayu-backend paths, relative to NEXT_PUBLIC_RAYU_API_URL. */
export const BACKEND = {
  /** Encrypted per-user third-party credentials. */
  connections: '/studio/connections',
  connection: (kind: string) => `/studio/connections/${kind}`,

  // --- source control (was api.github-*.ts / api.gitlab-*.ts) ---
  githubUser: '/studio/scm/github/user',
  githubRepos: '/studio/scm/github/repos',
  githubBranches: '/studio/scm/github/branches',
  githubStats: '/studio/scm/github/stats',
  /** Starter-template file tree + contents (was api.github-template.ts). */
  githubTemplate: '/studio/scm/github/template',
  /** Replaces bolt's browser-side @octokit/rest push. */
  githubPush: '/studio/scm/github/push',
  gitlabUser: '/studio/scm/gitlab/user',
  gitlabProjects: '/studio/scm/gitlab/projects',
  gitlabBranches: '/studio/scm/gitlab/branches',
  /** Replaces bolt's browser-side GitLabApiService push. */
  gitlabPush: '/studio/scm/gitlab/push',

  // --- deploys (was api.netlify-*.ts / api.vercel-*.ts) ---
  netlifyUser: '/studio/deploy/netlify/user',
  netlifySites: '/studio/deploy/netlify/sites',
  netlifyDeploy: '/studio/deploy/netlify',
  vercelUser: '/studio/deploy/vercel/user',
  vercelProjects: '/studio/deploy/vercel/projects',
  vercelDeploy: '/studio/deploy/vercel',
  deploymentStatus: '/studio/deploy/status',

  // --- supabase (was api.supabase*.ts) ---
  supabaseProjects: '/studio/supabase/projects',
  supabaseKeys: '/studio/supabase/keys',
  supabaseQuery: '/studio/supabase/query',

  // --- misc ---
  mcpConfig: '/studio/mcp/config',
  mcpCheck: '/studio/mcp/check',
  webSearch: '/studio/web-search',
  /** bolt's api.bug-report.ts; the backend already had a feedback module. */
  feedback: '/feedback',
} as const;

/** rayu-gateway paths, relative to NEXT_PUBLIC_RAYU_GATEWAY_URL. */
export const GATEWAY = {
  /**
   * THE hosted completion endpoint. Anthropic Messages wire format; the gateway
   * resolves which upstream provider actually serves the model and translates.
   *
   * bolt posted to its own /api/chat. Note the gateway's OpenAI-compatible
   * /v1/chat/completions is RETIRED and answers 410 — do not use it.
   */
  messages: '/anthropic/v1/messages',
  /** Free token counting, for context budgeting. */
  countTokens: '/anthropic/v1/messages/count_tokens',
  /** Was api.models.ts — already filtered to the user's plan entitlements. */
  models: '/v1/models',
  /** Was api.configured-providers.ts / api.check-env-key.ts. */
  entitlements: '/v1/_entitlements',
  credits: '/v1/credits',
  /** BYO-key tracking proxy. Identity via X-Rayu-Token, not Authorization. */
  proxy: '/v1/proxy',
} as const;

/**
 * bolt endpoints that were deliberately NOT ported, with the reason. Kept as
 * documentation so a future reader does not go looking for a missing route.
 */
export const REMOVED_ENDPOINTS: Record<string, string> = {
  '/api/system/diagnostics':
    'Reported the host machine bolt was installed on. On a shared host it describes Rayu infrastructure, not the user.',
  '/api/system/disk-info': 'Host filesystem introspection — infrastructure disclosure.',
  '/api/system/git-info': "Host repo introspection; utils/debugLogger.ts uses its client-side fallback instead.",
  '/api/git-info': 'Same as above.',
  '/api/update': 'Self-update of a local install; meaningless for a hosted app.',
  '/api/export-api-keys':
    'Returned provider keys to the client. The export feature now reads the browser-local apiKeys cookie directly.',
  '/api/health': 'rayu-backend exposes /api/health and rayu-gateway /healthz.',
  '/api/bug-report': "Superseded by the backend's existing /feedback module.",
};
