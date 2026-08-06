import type { Message } from 'ai';
import { gatewayUrl } from '@/lib/config';
import { GATEWAY } from '~/lib/rayu/endpoints';
import { gatewayHeaders, readCreditHeaders } from '~/lib/rayu/gatewayClient';
import { getAccessToken, redirectToSignIn, StudioAuthError } from '~/lib/rayu/session';
import { createScopedLogger } from '~/utils/logger';
import { anthropicSseToDataStream } from './anthropicToDataStream';
import { buildAnthropicRequest, resolveModel, type StudioChatBody } from './buildRequest';

const logger = createScopedLogger('studio-chat-transport');

/**
 * `useChat`'s transport for Rayu Studio.
 *
 * bolt.diy pointed `useChat` at its own `/api/chat` Remix route. Rayu Studio has
 * no server routes, so this fetch-compatible function stands in: it turns the
 * payload `useChat` posts into an Anthropic Messages request, streams it from
 * rayu-gateway, and hands back a Response whose body is the AI SDK data stream
 * `useChat` expects (see anthropicToDataStream.ts).
 *
 * TWO PATHS, DIFFERENT AUTH — the inversion is deliberate in the gateway:
 *
 *   billed   POST /anthropic/v1/messages
 *            Authorization: Bearer <rayu jwt>          credits are metered
 *
 *   BYO key  POST /v1/proxy
 *            X-Rayu-Token:  <rayu jwt>        identity
 *            Authorization: <provider key>    forwarded upstream
 *            X-Rayu-Upstream-URL: <provider>  no credits charged
 */

/** Where a BYO key sends its request, per provider. Anthropic-shaped only. */
const BYO_UPSTREAM: Record<string, string> = {
  Anthropic: 'https://api.anthropic.com/v1/messages',
};

/** Latest credit figures, for the UI to display after a completion. */
let lastCredits: ReturnType<typeof readCreditHeaders> | null = null;

export function getLastCredits(): ReturnType<typeof readCreditHeaders> | null {
  return lastCredits;
}

/**
 * Chooses the BYO upstream for a model, or null to use the billed gateway path.
 *
 * A BYO key is only usable when the studio can produce that provider's wire
 * format. Only Anthropic is Anthropic-shaped, so every other provider falls back
 * to the billed path rather than sending a malformed body — better to charge
 * credits than to fail with a confusing upstream 400.
 */
function resolveByoUpstream(model: string, apiKeys?: Record<string, string>): {
  url: string;
  key: string;
} | null {
  if (!apiKeys) {
    return null;
  }

  for (const [provider, url] of Object.entries(BYO_UPSTREAM)) {
    const key = apiKeys[provider];

    if (!key) {
      continue;
    }

    // Only route to the provider whose models are actually being requested.
    if (provider === 'Anthropic' && /^claude|sonnet|opus|haiku/i.test(model)) {
      return { url, key };
    }
  }

  return null;
}

/**
 * Drop-in `fetch` for `useChat`.
 *
 * The signature matches the global fetch so `useChat` can call it directly; the
 * `input` URL is ignored because the destination depends on the billed/BYO
 * decision made from the request body.
 */
export async function studioChatFetch(
  _input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const payload = JSON.parse((init?.body as string) ?? '{}') as {
    messages?: Message[];
  } & StudioChatBody;

  const messages = payload.messages ?? [];

  if (messages.length === 0) {
    return new Response('No messages to send', { status: 400 });
  }

  const anthropicRequest = buildAnthropicRequest(messages, payload);
  const model = resolveModel(messages);
  const byo = resolveByoUpstream(model, payload.apiKeys);

  let res: Response;

  if (byo) {
    const token = await getAccessToken();

    if (!token) {
      redirectToSignIn();
      throw new StudioAuthError();
    }

    logger.debug(`BYO-key completion for ${model} via the gateway proxy`);

    res = await fetch(gatewayUrl(GATEWAY.proxy), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Identity; Authorization is occupied by the user's provider key.
        'X-Rayu-Token': token,
        Authorization: `Bearer ${byo.key}`,
        'X-Rayu-Upstream-URL': byo.url,
        'X-Rayu-Query-Source': 'studio',
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(anthropicRequest),
      signal: init?.signal ?? null,
    });
  } else {
    logger.debug(`Billed completion for ${model}`);

    res = await fetch(gatewayUrl(GATEWAY.messages), {
      method: 'POST',
      headers: await gatewayHeaders({
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'X-Rayu-Intended-Model': model,
      }),
      body: JSON.stringify(anthropicRequest),
      signal: init?.signal ?? null,
    });
  }

  if (res.status === 401) {
    redirectToSignIn();
    throw new StudioAuthError();
  }

  if (!res.ok || !res.body) {
    /*
     * Surface the gateway's own message. It is the component that knows WHY a
     * request was refused — out of credits, model not in plan, daily turn cap —
     * and those are exactly the errors a user can act on.
     */
    const detail = await res.text().catch(() => '');
    let message = detail.slice(0, 500) || `${res.status} ${res.statusText}`;

    try {
      const parsed = JSON.parse(detail) as { error?: string | { message?: string } };
      const err = parsed.error;
      message = (typeof err === 'string' ? err : err?.message) ?? message;
    } catch {
      // Not JSON; the raw text is already the best available message.
    }

    return new Response(message, { status: res.status || 502 });
  }

  // Only the billed path reports credits.
  if (!byo) {
    lastCredits = readCreditHeaders(res);
  }

  return new Response(anthropicSseToDataStream(res.body), {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      // Tells the AI SDK client this body is the data-stream protocol.
      'X-Vercel-AI-Data-Stream': 'v1',
    },
  });
}
