/**
 * Hosted Telegram transport: adapts the backend's shared-bot endpoints to the
 * HostedRouter seam consumed by telegramApi.ts. Installing this router (on
 * hosted connect) reroutes every getUpdates/sendMessage/etc. call through
 * rayu-backend instead of api.telegram.org — the bridge code stays unchanged.
 */
import type { HostedRouter, PollOutcome } from './telegramApi.js'
import {
  getHostedBotInfo,
  getHostedUpdates,
  relayHostedSend,
} from './telegramHostedApi.js'

/**
 * Build a hosted router. It keeps its OWN inbound cursor (the backend uses
 * per-user row ids, not Telegram update_ids), so the `offset` the bridge passes
 * to getUpdates is intentionally ignored — acking is by the last row id seen.
 *
 * The cursor advances ONLY on a successful batch. A failed poll must not move it,
 * or the rows it was meant to ack would be deleted without ever being handled.
 */
export function createHostedRouter(): HostedRouter {
  let after = 0
  return {
    async getUpdates(): Promise<PollOutcome> {
      const result = await getHostedUpdates(after)
      if (result.kind !== 'ok') {
        // Propagate the typed failure (including `unlinked`) rather than
        // flattening it to an empty batch — the bridge decides what to do.
        return result
      }
      for (const row of result.batch.updates) {
        if (row.id > after) after = row.id
      }
      return { kind: 'ok', updates: result.batch.updates.map((row) => row.update) }
    },
    async call(method, params) {
      // getMe → shared bot info; setMyCommands is a no-op (the backend owns the
      // shared bot's command list — one user must not overwrite it globally).
      if (method === 'getMe') {
        const info = await getHostedBotInfo()
        return { username: info.username ?? undefined }
      }
      if (method === 'setMyCommands') return {}
      // Everything else (sendMessage, editMessageText, sendChatAction,
      // answerCallbackQuery) is relayed; the backend forces chat_id to the
      // caller's own linked chat and rejects non-whitelisted methods.
      return relayHostedSend(method, params)
    },
    async botUsername() {
      const info = await getHostedBotInfo()
      return info.username ?? undefined
    },
  }
}
