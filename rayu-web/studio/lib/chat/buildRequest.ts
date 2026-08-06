import type { Message } from 'ai';
import { PromptLibrary } from '~/lib/common/prompt-library';
import { WORK_DIR } from '~/utils/constants';
import { createFilesContext, extractPropertiesFromMessage } from './message-utils';
import { getCompletionTokenLimit } from './limits';
import type { FileMap } from './limits';

/**
 * Builds the Anthropic Messages request the gateway expects, from the payload
 * `useChat` sends.
 *
 * This is the half of bolt.diy's `app/lib/.server/llm/stream-text.ts` that had to
 * move into the browser. bolt assembled the system prompt, file context and token
 * limits in a Remix server route; Rayu Studio streams from rayu-gateway directly,
 * so the assembly happens here.
 *
 * CONSEQUENCE WORTH KNOWING: the system prompt is now visible to the user in
 * DevTools. That is acceptable for an MIT-derived tool whose prompts are already
 * public in the bolt.diy repository, but it is a deliberate change, not an
 * oversight — anything genuinely proprietary must not be added to these prompts.
 */

/** What Chat.client.tsx passes through `useChat`'s `body` option. */
export interface StudioChatBody {
  files?: FileMap;
  promptId?: string;
  contextOptimization?: boolean;
  chatMode?: 'discuss' | 'build';
  designScheme?: unknown;
  supabase?: {
    isConnected: boolean;
    hasSelectedProject: boolean;
    credentials?: { supabaseUrl?: string; anonKey?: string };
  };
  maxLLMSteps?: number;
  /** BYO provider keys, kept in the browser. Never forwarded on the billed path. */
  apiKeys?: Record<string, string>;
}

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string;
  max_tokens: number;
  stream: boolean;
}

/**
 * bolt encodes the chosen model and provider into the user message text as
 * `[Model: x]` / `[Provider: y]` markers, which the server then stripped. The
 * gateway resolves the provider itself from the model code, so only the model is
 * carried forward — but the markers still have to be removed or the model sees
 * them.
 */
function stripMarkers(content: string): string {
  return content
    .replace(/\[Model: .*?\]\n\n/g, '')
    .replace(/\[Provider: .*?\]\n\n/g, '')
    .trim();
}

/** Collapse the AI SDK message shape into Anthropic's plain-text content. */
function toAnthropicMessages(messages: Message[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];

  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') {
      // System messages are hoisted into the top-level `system` field below, and
      // Anthropic rejects any other role.
      continue;
    }

    const raw = Array.isArray(message.content)
      ? (message.content as Array<{ type?: string; text?: string }>)
          .filter((p) => p.type === 'text')
          .map((p) => p.text ?? '')
          .join('')
      : (message.content as string);

    const content = message.role === 'user' ? stripMarkers(raw) : raw;

    if (!content) {
      continue;
    }

    /*
     * Anthropic requires strictly alternating roles. Consecutive same-role
     * messages (which bolt can produce around tool results) are merged rather
     * than sent, which would be a 400.
     */
    const last = out[out.length - 1];

    if (last && last.role === message.role) {
      last.content = `${last.content}\n\n${content}`;
    } else {
      out.push({ role: message.role, content });
    }
  }

  return out;
}

/** Assemble the system prompt exactly as bolt's server route did. */
function buildSystemPrompt(body: StudioChatBody): string {
  let systemPrompt =
    PromptLibrary.getPropmtFromLibrary(body.promptId || 'default', {
      cwd: WORK_DIR,
      allowedHtmlElements: [],
      modificationTagName: 'bolt_file_modifications',
      designScheme: body.designScheme as never,
      supabase: body.supabase
        ? {
            isConnected: body.supabase.isConnected,
            hasSelectedProject: body.supabase.hasSelectedProject,
            credentials: body.supabase.credentials,
          }
        : undefined,
    }) ?? '';

  // The current project files, so the model can edit them.
  if (body.files && Object.keys(body.files).length > 0) {
    const filesContext = createFilesContext(body.files, true);
    systemPrompt = `${systemPrompt}\n\n${filesContext}`;
  }

  return systemPrompt;
}

/**
 * Model id for the gateway.
 *
 * The gateway validates this against the caller's plan entitlements and maps it to
 * an upstream provider, so an unknown id fails there with an actionable error
 * rather than being silently substituted here.
 */
export function resolveModel(messages: Message[]): string {
  // The most recent user message carries the picker's current selection.
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];

    if (m.role === 'user') {
      return extractPropertiesFromMessage(m).model;
    }
  }

  return extractPropertiesFromMessage(messages[messages.length - 1] ?? ({} as Message)).model;
}

export function buildAnthropicRequest(messages: Message[], body: StudioChatBody): AnthropicRequest {
  const model = resolveModel(messages);
  const system = buildSystemPrompt(body);

  return {
    model,
    system: system || undefined,
    messages: toAnthropicMessages(messages),
    max_tokens: getCompletionTokenLimit(model),
    stream: true,
  };
}
