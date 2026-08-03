import { gatewayUrl } from '@/lib/config';
import { GATEWAY } from './endpoints';
import {
  StudioAuthError,
  StudioRequestError,
  getAccessToken,
  redirectToSignIn,
} from './session';

/**
 * Client for rayu-gateway — the ONLY service the studio may ask for a model
 * completion. Credit metering, plan entitlements, provider routing and BYO-key
 * tracking all live behind these endpoints.
 *
 * Two paths exist and they authenticate differently, which is easy to get
 * backwards:
 *
 *   billed  POST /anthropic/v1/messages
 *           Authorization: Bearer <rayu jwt>
 *
 *   BYO key ALL  /v1/proxy
 *           X-Rayu-Token:  <rayu jwt>        <- identity
 *           Authorization: <user provider key>  <- forwarded upstream
 *           X-Rayu-Upstream-URL: <provider endpoint>
 *
 * The inversion is deliberate in the gateway: on the BYO path `Authorization` is
 * occupied by the third-party credential being relayed.
 */

/** Names the client so gateway usage rows can be attributed (usage_events.source). */
export const STUDIO_QUERY_SOURCE = 'studio';

/** Credit figures the gateway reports on every billed response. */
export interface CreditHeaders {
  used: number | null;
  remaining: number | 'unlimited' | null;
  topupBalance: number | null;
}

/**
 * Read the credit headers off a gateway response.
 *
 * These are only visible to the browser because the gateway lists them in
 * Access-Control-Expose-Headers; cross-origin JS cannot read unexposed headers.
 */
export function readCreditHeaders(res: Response): CreditHeaders {
  const num = (v: string | null): number | null => (v === null || v === '' ? null : Number(v));
  const remainingRaw = res.headers.get('x-rayu-credits-remaining');

  return {
    used: num(res.headers.get('x-rayu-credits-used')),
    remaining: remainingRaw === 'unlimited' ? 'unlimited' : num(remainingRaw),
    topupBalance: num(res.headers.get('x-rayu-topup-balance')),
  };
}

/** A correlation id, so one logical request is traceable across retries. */
export function newRequestId(): string {
  const bytes = new Uint8Array(12);

  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }

  return `studio_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** Headers common to every gateway call. */
export async function gatewayHeaders(
  extra: Record<string, string> = {},
): Promise<Record<string, string>> {
  const token = await getAccessToken();

  if (!token) {
    redirectToSignIn();
    throw new StudioAuthError();
  }

  return {
    Authorization: `Bearer ${token}`,
    'X-Rayu-Query-Source': STUDIO_QUERY_SOURCE,
    'X-Rayu-Request-Id': newRequestId(),
    ...extra,
  };
}

/** GET a gateway metadata endpoint (models, credits, entitlements). */
export async function gatewayGet<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(gatewayUrl(path), {
    method: 'GET',
    headers: await gatewayHeaders(),
    signal,
  });

  if (res.status === 401) {
    redirectToSignIn();
    throw new StudioAuthError();
  }

  const text = await res.text();

  if (!res.ok) {
    throw new StudioRequestError(text.slice(0, 300) || `${res.status} ${res.statusText}`, res.status);
  }

  return (text ? JSON.parse(text) : undefined) as T;
}

/**
 * Raw `Response` from a gateway endpoint, with auth attached.
 *
 * Same rationale as backendFetch: keeps ported bolt.diy call sites a one-line
 * change instead of a restructure.
 */
export async function gatewayFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(gatewayUrl(path), {
    ...init,
    headers: await gatewayHeaders(init.headers as Record<string, string> | undefined),
  });
}

/** A model the user's plan allows, as reported by the gateway. */
export interface GatewayModel {
  id: string;
  label: string;
  object: string;
  owned_by: string;
  supportsReasoning: boolean;
  supportsImage: boolean;
  supportsTools: boolean;
  /** Admin-set context window in tokens; null when unset. */
  contextWindow: number | null;
}

/**
 * Models the signed-in user may call. Already filtered to their plan, so the UI
 * does not need to check entitlements itself.
 */
export async function fetchGatewayModels(signal?: AbortSignal): Promise<GatewayModel[]> {
  const body = await gatewayGet<{ data?: GatewayModel[] } | GatewayModel[]>(
    GATEWAY.models,
    signal,
  );

  return Array.isArray(body) ? body : (body.data ?? []);
}

export interface GatewayCredits {  used: number;
  cap: number | null;
  remaining: number | 'unlimited';
  topupBalance?: number;
}

export function fetchGatewayCredits(signal?: AbortSignal): Promise<GatewayCredits> {
  return gatewayGet<GatewayCredits>(GATEWAY.credits, signal);
}

/**
 * Count tokens for a prospective request without spending anything.
 *
 * Free and unmetered on the gateway, which is what makes real context budgeting
 * possible instead of estimating.
 */
export async function countGatewayTokens(
  payload: { model: string; messages: unknown[]; system?: unknown },
  signal?: AbortSignal,
): Promise<number | null> {
  try {
    const res = await fetch(gatewayUrl(GATEWAY.countTokens), {
      method: 'POST',
      headers: await gatewayHeaders({
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      }),
      body: JSON.stringify(payload),
      signal,
    });

    if (!res.ok) {
      return null;
    }

    const data = (await res.json()) as { input_tokens?: number };

    return data.input_tokens ?? null;
  } catch {
    // Budgeting is advisory: a failure here must not block the request itself.
    return null;
  }
}
