import type {
  MediaBackend,
  MediaCapability,
  MediaFamily,
  MediaType,
  PlanCode,
} from '../common/enums'

/**
 * One row of the image/video generation catalog.
 *
 * This is METADATA ONLY. Media models are not proxied by the gateway — the CLI
 * calls NVIDIA / Vertex / fal directly with the user's own key — so nothing here
 * is a credential, a base URL the gateway follows, or a billing rate.
 */
export interface MediaModelSeed {
  /** Exact model id sent upstream. */
  code: string
  label: string
  mediaType: MediaType
  /**
   * Everything the model can do. An array because some models do both (e.g.
   * cosmos-predict1-5b accepts an optional input image), and the CLI must be able
   * to offer one model for both operations with no code change.
   */
  capabilities: MediaCapability[]
  backend: MediaBackend
  /** Request-shape family; the CLI keys its body builder off this. */
  family: MediaFamily
  /** NVCF function UUID (video, `nvcf` backend only). */
  nvcfFunctionId?: string
  /** Rough generation seconds for the CLI's wait message. */
  estimatedSeconds?: number
  /**
   * Per-model request defaults merged into the family body builder. This is what
   * lets flux.1-schnell (cfg 0 / 4 steps, guidance-distilled) and flux.1-dev
   * (cfg 3.5 / 50 steps) share the single `flux` family.
   */
  defaultParams?: Record<string, unknown>
  /** Plans allowed to use it. EMPTY = every plan (see the Prisma comment). */
  allowedPlanCodes?: PlanCode[]
  /** Preferred pick for its (mediaType, backend) pair. */
  isDefault?: boolean
  sortOrder: number
  enabled: boolean
}

/**
 * First-boot defaults. These are the models the CLI used to hardcode in
 * `src/tools/ImageGenTool/models.ts` and `src/tools/VideoGenTool/models.ts`;
 * moving them here is what makes the CLI's registry server-driven.
 *
 * Every field is admin-editable afterwards and the seed is non-destructive, so a
 * model an admin disabled or deleted stays that way (see
 * MediaModelsService.seedDefaults for the exact rule).
 *
 * allowedPlanCodes is deliberately EMPTY on all seeds: media generation is gated
 * by the `image_generation` / `video_generation` FEATURE flags per plan, not by a
 * per-model plan list. An admin who wants a specific model restricted to Max can
 * set its plan list in the dashboard.
 */
export const MEDIA_MODEL_SEED: MediaModelSeed[] = [
  // ── Image · NVIDIA genai host (ai.api.nvidia.com/v1/genai) ─────────────────
  {
    // Guidance-distilled: the NVIDIA endpoint requires cfg_scale<=0 and 1-4 steps.
    code: 'black-forest-labs/flux.1-schnell',
    label: 'FLUX.1 Schnell',
    mediaType: 'image',
    capabilities: ['generate'],
    backend: 'nvidia',
    family: 'flux',
    defaultParams: { cfg_scale: 0, steps: 4 },
    isDefault: true,
    sortOrder: 10,
    enabled: true,
  },
  {
    // Uses real guidance, so a much higher cfg_scale and step count.
    code: 'black-forest-labs/flux.1-dev',
    label: 'FLUX.1 Dev',
    mediaType: 'image',
    capabilities: ['generate'],
    backend: 'nvidia',
    family: 'flux',
    defaultParams: { cfg_scale: 3.5, steps: 50 },
    sortOrder: 20,
    enabled: true,
  },
  {
    code: 'stabilityai/stable-diffusion-3.5-large',
    label: 'Stable Diffusion 3.5 Large',
    mediaType: 'image',
    capabilities: ['generate'],
    backend: 'nvidia',
    family: 'sd3',
    defaultParams: { cfg_scale: 4.5, steps: 50, aspect_ratio: '1:1' },
    sortOrder: 30,
    enabled: true,
  },
  {
    // In-context editing: needs the input image uploaded as an NVCF asset first.
    code: 'black-forest-labs/flux.1-kontext-dev',
    label: 'FLUX.1 Kontext Dev (edit)',
    mediaType: 'image',
    capabilities: ['edit'],
    backend: 'nvidia',
    family: 'kontext',
    defaultParams: { cfg_scale: 3.5, steps: 30 },
    isDefault: true,
    sortOrder: 40,
    enabled: true,
  },

  // ── Image · Google Vertex AI (Imagen, publisher :predict) ─────────────────
  {
    code: 'imagen-4.0-generate-001',
    label: 'Imagen 4',
    mediaType: 'image',
    capabilities: ['generate'],
    backend: 'vertex',
    family: 'imagen',
    isDefault: true,
    sortOrder: 50,
    enabled: true,
  },
  {
    code: 'imagen-4.0-fast-generate-001',
    label: 'Imagen 4 Fast',
    mediaType: 'image',
    capabilities: ['generate'],
    backend: 'vertex',
    family: 'imagen',
    sortOrder: 60,
    enabled: true,
  },
  {
    code: 'imagen-4.0-ultra-generate-001',
    label: 'Imagen 4 Ultra',
    mediaType: 'image',
    capabilities: ['generate'],
    backend: 'vertex',
    family: 'imagen',
    sortOrder: 70,
    enabled: true,
  },
  {
    // Imagen 4 is generate-only; editing uses the Imagen 3 capability model.
    code: 'imagen-3.0-capability-001',
    label: 'Imagen 3 Capability (edit)',
    mediaType: 'image',
    capabilities: ['edit'],
    backend: 'vertex',
    family: 'imagen',
    isDefault: true,
    sortOrder: 80,
    enabled: true,
  },

  // ── Video · NVIDIA Physical AI via NVCF (api.nvcf.nvidia.com/v2/nvcf/pexec) ─
  {
    // Takes an OPTIONAL input image, so it serves both text2video and
    // image2video — which is why the CLI's old hardcoded
    // DEFAULT_IMAGE2VIDEO_MODEL was this same model.
    code: 'nvidia/cosmos-predict1-5b',
    label: 'Cosmos Predict1 5B',
    mediaType: 'video',
    capabilities: ['text2video', 'image2video'],
    backend: 'nvcf',
    family: 'cosmos-predict1',
    nvcfFunctionId: 'eef816a3-3940-413b-93c9-513ae29f34f9',
    estimatedSeconds: 120,
    isDefault: true,
    sortOrder: 10,
    enabled: true,
  },
  {
    code: 'nvidia/cosmos-transfer1-7b',
    label: 'Cosmos Transfer1 7B',
    mediaType: 'video',
    capabilities: ['image2video'],
    backend: 'nvcf',
    family: 'cosmos-transfer1',
    nvcfFunctionId: 'abb63707-47ee-497c-81a3-37e685bacdc6',
    estimatedSeconds: 120,
    sortOrder: 20,
    enabled: true,
  },
  {
    code: 'nvidia/cosmos3-nano',
    label: 'Cosmos3 Nano',
    mediaType: 'video',
    capabilities: ['text2video'],
    backend: 'nvcf',
    family: 'cosmos3-nano',
    nvcfFunctionId: 'd09cd49d-d7f2-4361-928f-ea22af707249',
    estimatedSeconds: 90,
    sortOrder: 30,
    enabled: true,
  },
  {
    // Legacy Triton format on the dedicated cosmos host — no NVCF function id.
    code: 'nvidia/cosmos-1.0-7b-diffusion-text2world',
    label: 'Cosmos 1.0 7B Text2World',
    mediaType: 'video',
    capabilities: ['text2video'],
    backend: 'nvcf',
    family: 'cosmos-legacy',
    estimatedSeconds: 120,
    sortOrder: 40,
    enabled: true,
  },

  // ── Video · NVIDIA Stable Video Diffusion (genai host) ────────────────────
  {
    code: 'stabilityai/stable-video-diffusion',
    label: 'Stable Video Diffusion',
    mediaType: 'video',
    capabilities: ['image2video'],
    backend: 'nvidia-svd',
    family: 'svd',
    estimatedSeconds: 60,
    defaultParams: { cfg_scale: 1.8, motion_bucket_id: 127 },
    sortOrder: 50,
    enabled: true,
  },

  // ── Video · fal.ai (used when the user has FAL_KEY instead of NVIDIA) ─────
  {
    code: 'fal-ai/kling-video/v2.1/standard/text-to-video',
    label: 'Kling Video 2.1 (text-to-video)',
    mediaType: 'video',
    capabilities: ['text2video'],
    backend: 'fal',
    family: 'fal-kling',
    estimatedSeconds: 90,
    defaultParams: { duration: '5', aspect_ratio: '16:9', cfg_scale: 0.5 },
    isDefault: true,
    sortOrder: 60,
    enabled: true,
  },
  {
    code: 'fal-ai/kling-video/v2.1/standard/image-to-video',
    label: 'Kling Video 2.1 (image-to-video)',
    mediaType: 'video',
    capabilities: ['image2video'],
    backend: 'fal',
    family: 'fal-kling',
    estimatedSeconds: 90,
    defaultParams: { duration: '5', aspect_ratio: '16:9' },
    sortOrder: 70,
    enabled: true,
  },

  // ── Video · Google Vertex AI Veo (:predictLongRunning) ───────────────────
  // GA ids only. The …-generate-preview ids were retired by Google 2026-04-02.
  {
    code: 'veo-3.1-generate-001',
    label: 'Veo 3.1',
    mediaType: 'video',
    capabilities: ['text2video', 'image2video'],
    backend: 'vertex',
    family: 'veo',
    estimatedSeconds: 120,
    isDefault: true,
    sortOrder: 80,
    enabled: true,
  },
  {
    code: 'veo-3.1-fast-generate-001',
    label: 'Veo 3.1 Fast',
    mediaType: 'video',
    capabilities: ['text2video', 'image2video'],
    backend: 'vertex',
    family: 'veo',
    estimatedSeconds: 90,
    sortOrder: 90,
    enabled: true,
  },
  {
    code: 'veo-3.0-generate-001',
    label: 'Veo 3.0',
    mediaType: 'video',
    capabilities: ['text2video', 'image2video'],
    backend: 'vertex',
    family: 'veo',
    estimatedSeconds: 120,
    sortOrder: 100,
    enabled: true,
  },
  {
    code: 'veo-3.0-fast-generate-001',
    label: 'Veo 3.0 Fast',
    mediaType: 'video',
    capabilities: ['text2video', 'image2video'],
    backend: 'vertex',
    family: 'veo',
    estimatedSeconds: 90,
    sortOrder: 110,
    enabled: true,
  },
]
