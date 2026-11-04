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
 * Picker order: Rayu-hosted models first, then bring-your-own ones, each group
 * in the order the gateway returned it.
 *
 * Gateway order is the admin's: hosted rows are sorted by their Sort Order in
 * Admin → Media Catalogs, and the first hosted row that can do a request is the
 * default a signed-in user gets. Listing hosted rows first keeps the picker in
 * the same order the tools pick from.
 */
export function orderMediaModelsForPicker(
  entries: readonly MediaModelEntry[],
): MediaModelEntry[] {
  return [
    ...entries.filter((m) => m.backend === 'rayu'),
    ...entries.filter((m) => m.backend !== 'rayu'),
  ]
}

/**
 * The IMAGE models a picker may OFFER: Rayu-hosted only.
 *
 * Image generation ships as a Rayu-hosted capability — the user needs no
 * provider key and is billed in Rayu credits — so the picker lists exactly the
 * hosted rows the admin enabled, in the admin's order. BYO Imagen rows may
 * still exist in the catalog (older clients and an already-saved selection keep
 * working), but neither the terminal nor the editor OFFERS them as a choice, so
 * what a user can pick here is what the dashboard publishes.
 *
 * Video is deliberately NOT filtered the same way; this function is image-only.
 */
export function hostedImagePickerModels(
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
      return entry.mediaType === 'image' ? 'Vertex Imagen' : 'Vertex Veo'
    case 'fal':
      return 'fal.ai'
    default:
      return entry.backend
  }
}

/** "Rayu-hosted · generate, edit" — backend and capabilities, from the catalog. */
function backendAndCapabilities(entry: MediaModelEntry): string {
  return `${mediaBackendLabel(entry)} · ${entry.capabilities.join(', ')}`
}

/**
 * The terminal picker's detail line: the admin's display name (when it is not
 * just the id), then backend and capabilities. The id is the row's label, as in
 * the chat /model picker, because it is what gets saved and sent.
 */
export function describeMediaModel(entry: MediaModelEntry): string {
  const named = entry.label && entry.label !== entry.id ? `${entry.label} · ` : ''
  return `${named}${backendAndCapabilities(entry)}`
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
  const entries =
    mediaType === 'image'
      ? hostedImagePickerModels(mediaModelsFor(catalog, mediaType))
      : orderMediaModelsForPicker(mediaModelsFor(catalog, mediaType))
  return entries.map((m) => ({
    value: m.id,
    label: m.label || m.id,
    description: `${m.id} · ${backendAndCapabilities(m)}`,
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
    return catalog.source === 'fallback'
      ? 'Showing built-in defaults. Sign in to Rayu (/login) or connect a Rayu API key to see the hosted models your Rayu admin publishes.'
      : undefined
  }
  if (refreshed) return undefined
  return catalog.source === 'gateway'
    ? 'Could not refresh the list from Rayu; showing the last list it sent.'
    : 'Could not reach Rayu; showing built-in defaults. Check your connection and open this picker again.'
}

/**
 * What to say when the image chooser is empty because policy hid every row.
 *
 * Shared by the terminal command and the editor so the two never explain the
 * same empty list differently.
 */
export const EMPTY_HOSTED_IMAGE_PICKER_NOTE =
  'No Rayu-hosted image models are available. They are published by your Rayu ' +
  'admin, so ask them to enable one — signing in will not create any.'

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
  /** Set when `options` is empty although the catalog HAS models of this type. */
  hiddenByPolicy?: boolean
}> {
  const fresh = await refreshMediaModels(true)
  const catalog = fresh ?? getCachedMediaModels()
  const notice = mediaCatalogNotice(catalog, fresh !== null)
  const options = mediaModelPickerOptions(catalog, mediaType)
  // Image generation offers Rayu-hosted models ONLY, so a catalog that carries
  // just BYO rows yields an empty list. Say why instead of showing nothing —
  // the fix is a hosted catalog row, not something the user can do here.
  const hiddenByPolicy =
    options.length === 0 && mediaModelsFor(catalog, mediaType).length > 0
  return {
    options,
    ...(notice ? { notice } : {}),
    ...(hiddenByPolicy ? { hiddenByPolicy } : {}),
  }
}
