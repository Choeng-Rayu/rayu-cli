// How the image and video model pickers present the media catalog — one
// definition for the terminal pickers (/model_image_generation,
// /model_video_generation) and the Rayucode chooser that answers the same
// commands in VS Code.
//
// The catalog itself is server-owned (mediaModels.ts). This module only decides
// the PRESENTATION: the order, the backend names, the detail line, and the
// caveat shown when the list on screen is not the admin's current one. Keeping
// it in one place is what makes the terminal and the editor list the same
// models in the same order.
//
// Opening a picker always asks the gateway again (refreshMediaModels(true)), the
// way the chat /model picker refreshes its catalog on open, so a model the admin
// added, renamed, reordered or disabled seconds ago shows up immediately.
import {
  getCachedMediaModels,
  mediaModelsFor,
  refreshMediaModels,
  type MediaCatalog,
  type MediaModelEntry,
  type MediaType,
} from './mediaModels.js'
import { hasRayuGatewayCredential } from './rayuApiKeyAuth.js'

/**
 * The models a picker may OFFER: Rayu-hosted only, for every media type.
 *
 * Generation ships as a Rayu-hosted capability — the user needs no provider key
 * and is billed in Rayu credits — so the pickers list exactly the hosted rows the
 * admin enabled, in the admin's order. Video has no other backend at all (the
 * fal.ai and Vertex clients were removed); an IMAGE catalog may still carry BYO
 * Imagen rows for older clients and an already-saved selection, but neither the
 * terminal nor the editor OFFERS them as a choice, so what a user can pick here
 * is what the dashboard publishes.
 */
export function hostedPickerModels(
  entries: readonly MediaModelEntry[],
): MediaModelEntry[] {
  return entries.filter((m) => m.backend === 'rayu')
}

/** Human name for the upstream that serves a model. */
export function mediaBackendLabel(
  entry: Pick<MediaModelEntry, 'backend' | 'mediaType'>,
): string {
  switch (entry.backend) {
    case 'rayu':
      return 'Rayu-hosted'
    case 'vertex':
      // Vertex is an IMAGE-only backend now (the Veo video client was removed).
      return entry.mediaType === 'image' ? 'Vertex Imagen' : 'Vertex'
    default:
      return entry.backend
  }
}

/** "Rayu-hosted · generate, edit" — backend and capabilities, from the catalog. */
function backendAndCapabilities(entry: MediaModelEntry): string {
  return `${mediaBackendLabel(entry)} · ${entry.capabilities.join(', ')}`
}

/**
 * The clip window a video entry publishes ("· 2-10s"), or '' when it declares
 * none. Shown so a caller can tell WHY a requested length was clamped instead
 * of discovering it from a gateway rejection.
 */
function durationRangeLabel(entry: MediaModelEntry): string {
  if (entry.mediaType !== 'video') return ''
  const max = entry.maxDurationSeconds
  if (max === undefined) return ''
  const min = entry.minDurationSeconds
  return min !== undefined ? ` · ${min}-${max}s` : ` · up to ${max}s`
}

/**
 * The terminal picker's detail line: the admin's display name (when it is not
 * just the id), then backend and capabilities. The id is the row's label, as in
 * the chat /model picker, because it is what gets saved and sent.
 */
export function describeMediaModel(entry: MediaModelEntry): string {
  const named = entry.label && entry.label !== entry.id ? `${entry.label} · ` : ''
  return `${named}${backendAndCapabilities(entry)}${durationRangeLabel(entry)}`
}

/** One chooser row — structurally the editor's `ModelOptionView`. */
export interface MediaModelPickerOption {
  /** The model id: what is saved as the selection and sent as the tool's `model`. */
  value: string
  /** The admin's display name, falling back to the id. */
  label: string
  /** "<id> · <backend> · <capabilities>". */
  description: string
  /** Same as `value`; the chooser matches the current selection against it. */
  model: string
  /** The catalog backend (`rayu`, `vertex`, `fal`). */
  providerId: string
}

/**
 * The editor chooser's rows for one media type, in picker order. The editor
 * leads with the display name and puts the id in the detail line, as its chat
 * model dropdown does.
 */
export function mediaModelPickerOptions(
  catalog: MediaCatalog,
  mediaType: MediaType,
): MediaModelPickerOption[] {
  const entries = hostedPickerModels(mediaModelsFor(catalog, mediaType))
  return entries.map((m) => ({
    value: m.id,
    label: m.label || m.id,
    description: `${m.id} · ${backendAndCapabilities(m)}${durationRangeLabel(m)}`,
    model: m.id,
    providerId: m.backend,
  }))
}

/**
 * A one-line caveat when the list on screen is not the admin's current one, or
 * undefined when it is.
 *
 * `refreshed` is whether the live fetch the picker just made succeeded.
 */
export function mediaCatalogNotice(
  catalog: MediaCatalog,
  refreshed: boolean,
): string | undefined {
  // Either credential reaches the gateway, so an API-key user is as "signed in"
  // as a session user and must not be told to run /login.
  const signedIn = hasRayuGatewayCredential()
  if (!signedIn) {
    // Hosted models are the only ones a picker offers, so without a credential
    // there is nothing to show at all — do not promise "built-in defaults" for a
    // media type whose built-in list is empty (video).
    return 'No Rayu credential. Sign in (/login) or connect a Rayu API key to see the hosted models your Rayu admin publishes.'
  }
  if (refreshed) return undefined
  return catalog.source === 'gateway'
    ? 'Could not refresh the list from Rayu; showing the last list it sent.'
    : 'Could not reach Rayu. Check your connection and open this picker again.'
}

/**
 * What to say when a chooser is empty because only Rayu-hosted rows may be
 * offered and the catalog has none.
 *
 * Shared by both terminal commands and the editor so neither explains the same
 * empty list differently.
 */
export function emptyHostedPickerNote(mediaType: MediaType): string {
  const kind = mediaType === 'image' ? 'image' : 'video'
  return (
    `No Rayu-hosted ${kind} models are available. They are published by your Rayu ` +
    `admin, so ask them to enable one — signing in will not create any.`
  )
}

/**
 * Fetch the live catalog — bypassing the cache TTL, as opening a picker should —
 * and project one media type for the editor's chooser.
 *
 * Never throws: when the fetch fails, the last catalog this process knows (or
 * the built-in fallback) is listed, with a notice that says so.
 */
export async function loadMediaModelPicker(mediaType: MediaType): Promise<{
  options: MediaModelPickerOption[]
  notice?: string
}> {
  const fresh = await refreshMediaModels(true)
  const catalog = fresh ?? getCachedMediaModels()
  // An EMPTY option list always needs an explanation, whatever emptied it: policy
  // (only hosted rows may be offered, and the catalog had none) or a catalog that
  // genuinely lists nothing of this type. Without it the editor renders a bare
  // chooser and the user cannot tell "nothing published" from "nothing reachable".
  const notice = mediaCatalogNotice(catalog, fresh !== null)
  const options = mediaModelPickerOptions(catalog, mediaType)
  const resolved =
    notice ?? (options.length === 0 ? emptyHostedPickerNote(mediaType) : undefined)
  return {
    options,
    ...(resolved ? { notice: resolved } : {}),
  }
}
