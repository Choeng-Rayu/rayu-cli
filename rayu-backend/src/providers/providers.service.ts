import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import type { Provider, ProviderApiKey } from '@prisma/client'
import {
  PROVIDER_AUTH_SCHEMES,
  PROVIDER_FORMATS,
  type ProviderAuthScheme,
  type ProviderFormat,
  type ProviderKeyStatus,
} from '../common/enums'
import {
  encryptSecret,
  hashKey,
  maskSecret,
  ProviderSecretError,
} from '../common/secretBox'
import {
  insecureBaseUrlsAllowed,
  validateBaseUrl,
  validateEndpointPath,
} from '../common/provider-security'
import { PrismaService } from '../prisma/prisma.service'
import { FORMAT_DEFAULTS, PROVIDER_SEED } from './providers.constants'

/** A provider name is a URL-safe slug: it appears in logs and health output. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/

export interface ProviderPatch {
  label?: string
  format?: ProviderFormat
  baseUrl?: string
  endpointPath?: string | null
  authScheme?: ProviderAuthScheme
  supportsReasoning?: boolean
  supportsImage?: boolean
  enabled?: boolean
}

export interface CreateProvider extends ProviderPatch {
  name: string
}

/** Provider row plus how many hosted models point at it (for the admin UI). */
export type ProviderWithModelCount = Provider & { modelCount: number }

/**
 * A provider API key as the API returns it. There is deliberately NO field for
 * the key itself: once saved, the plaintext is never readable through the API
 * again, and `maskedKey` is what the dashboard displays.
 */
export interface ProviderKeyView {
  id: number
  label: string
  maskedKey: string
  priority: number
  enabled: boolean
  status: ProviderKeyStatus
  lastUsedAt: Date | null
  cooldownUntil: Date | null
  lastError: string | null
  createdAt: Date
}

/** Project a key row to its safe view. The ONLY way keys leave this service. */
function toKeyView(k: ProviderApiKey): ProviderKeyView {
  return {
    id: k.id,
    label: k.label,
    maskedKey: k.maskedKey,
    priority: k.priority,
    enabled: k.enabled,
    status: k.status as ProviderKeyStatus,
    lastUsedAt: k.lastUsedAt,
    cooldownUntil: k.cooldownUntil,
    lastError: k.lastError,
    createdAt: k.createdAt,
  }
}

@Injectable()
export class ProvidersService {
  private readonly logger = new Logger(ProvidersService.name)

  constructor(private readonly prisma: PrismaService) {}

  /** Every provider, with model counts, for the admin registry page. */
  async findAll(): Promise<ProviderWithModelCount[]> {
    const rows = await this.prisma.provider.findMany({
      orderBy: { id: 'asc' },
      include: { _count: { select: { models: true } } },
    })
    return rows.map(({ _count, ...p }) => ({ ...p, modelCount: _count.models }))
  }

  findByName(name: string): Promise<Provider | null> {
    return this.prisma.provider.findUnique({ where: { name } })
  }

  async create(data: CreateProvider): Promise<Provider> {
    const name = (data.name ?? '').trim().toLowerCase()
    if (!NAME_PATTERN.test(name)) {
      throw new BadRequestException(
        'name must be a lowercase slug (letters, digits, ".", "_", "-"; 2-64 chars)',
      )
    }
    const format = this.requireFormat(data.format)
    const defaults = FORMAT_DEFAULTS[format]
    const endpointPath = this.normalizePath(
      data.endpointPath === undefined ? defaults.endpointPath : data.endpointPath,
    )
    const authScheme = data.authScheme ?? defaults.authScheme
    this.requireAuthScheme(authScheme)

    const baseUrl = this.normalizeBaseUrl(data.baseUrl ?? '')
    this.assertSecure({ baseUrl, endpointPath })

    if (await this.findByName(name)) {
      throw new ConflictException(`Provider "${name}" already exists`)
    }

    const created = await this.prisma.provider.create({
      data: {
        name,
        label: data.label?.trim() || name,
        format,
        baseUrl,
        endpointPath,
        authScheme,
        supportsReasoning: data.supportsReasoning ?? false,
        supportsImage: data.supportsImage ?? false,
        enabled: data.enabled ?? true,
      },
    })
    // Audit trail: provider config decides where user traffic + our keys go.
    this.logger.log(
      `provider created name=${created.name} format=${created.format} baseUrl=${created.baseUrl} enabled=${created.enabled}`,
    )
    return created
  }

  async update(name: string, patch: ProviderPatch): Promise<Provider> {
    const existing = await this.findByName(name)
    if (!existing) throw new NotFoundException(`Unknown provider: ${name}`)

    const format =
      patch.format === undefined
        ? (existing.format as ProviderFormat)
        : this.requireFormat(patch.format)
    const authScheme =
      patch.authScheme === undefined
        ? (existing.authScheme as ProviderAuthScheme)
        : patch.authScheme
    this.requireAuthScheme(authScheme)

    // A format change without an explicit path re-derives the format's default,
    // so switching e.g. openai_chat → openai_responses can't keep a stale path.
    const endpointPath =
      patch.endpointPath !== undefined
        ? this.normalizePath(patch.endpointPath)
        : patch.format !== undefined && patch.format !== existing.format
          ? this.normalizePath(FORMAT_DEFAULTS[format].endpointPath)
          : existing.endpointPath

    const baseUrl =
      patch.baseUrl === undefined
        ? existing.baseUrl
        : this.normalizeBaseUrl(patch.baseUrl)

    this.assertSecure({ baseUrl, endpointPath })

    const updated = await this.prisma.provider.update({
      where: { name },
      data: {
        label: patch.label?.trim() || undefined,
        format,
        baseUrl,
        endpointPath,
        authScheme,
        ...(patch.supportsReasoning !== undefined
          ? { supportsReasoning: patch.supportsReasoning }
          : {}),
        ...(patch.supportsImage !== undefined
          ? { supportsImage: patch.supportsImage }
          : {}),
        ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      },
    })
    this.logger.log(
      `provider updated name=${updated.name} format=${updated.format} baseUrl=${updated.baseUrl} enabled=${updated.enabled}`,
    )
    return updated
  }

  /**
   * Delete a provider. Refused while hosted models still reference it — the FK
   * is RESTRICT, and a 409 with the model count is far more useful to the admin
   * than a raw constraint violation.
   */
  async remove(name: string): Promise<{ deleted: true }> {
    const existing = await this.findByName(name)
    if (!existing) throw new NotFoundException(`Unknown provider: ${name}`)
    const modelCount = await this.prisma.hostedModel.count({
      where: { providerId: existing.id },
    })
    if (modelCount > 0) {
      throw new ConflictException(
        `Provider "${name}" still has ${modelCount} model(s). Reassign or delete them first.`,
      )
    }
    await this.prisma.provider.delete({ where: { name } })
    this.logger.warn(`provider deleted name=${name}`)
    return { deleted: true }
  }

  /**
   * Create-if-missing seed of the shipped providers. Non-destructive: an
   * existing row is never touched, because base URL / key env / capabilities are
   * admin-owned once the provider exists.
   */
  async seedDefaults(): Promise<void> {
    for (const p of PROVIDER_SEED) {
      const existing = await this.findByName(p.name)
      if (existing) continue
      await this.prisma.provider.create({
        data: {
          name: p.name,
          label: p.label,
          format: p.format,
          baseUrl: p.baseUrl,
          endpointPath:
            p.endpointPath === undefined
              ? FORMAT_DEFAULTS[p.format].endpointPath
              : p.endpointPath,
          authScheme: p.authScheme ?? FORMAT_DEFAULTS[p.format].authScheme,
          supportsReasoning: p.supportsReasoning,
          supportsImage: p.supportsImage,
          enabled: p.enabled,
        },
      })
    }
    await this.auditProviderConfig()
  }

  /**
   * Boot-time audit: WARN (never mutate) about provider rows whose baseUrl or
   * endpointPath would be refused today — e.g. a row written before these rules,
   * or edited directly in the database. The gateway independently refuses to
   * route them; this just makes the reason visible to operators.
   */
  async auditProviderConfig(): Promise<void> {
    const all = await this.prisma.provider.findMany({ orderBy: { id: 'asc' } })
    const allowInsecure = insecureBaseUrlsAllowed()
    for (const p of all) {
      const problems = [
        validateBaseUrl(p.baseUrl, { allowInsecure }),
        validateEndpointPath(p.endpointPath),
      ].filter((e): e is NonNullable<typeof e> => e !== null)
      if (!PROVIDER_FORMATS.includes(p.format as ProviderFormat)) {
        problems.push({
          field: 'baseUrl',
          message: `unknown format "${p.format}" — the gateway cannot route this provider`,
        })
      }
      for (const problem of problems) {
        this.logger.warn(
          `provider "${p.name}" has invalid ${problem.field}: ${problem.message}. ` +
            `The gateway will refuse to route its models until this is fixed in the admin dashboard.`,
        )
      }
    }
  }

  // --- API keys --------------------------------------------------------------
  //
  // Keys are stored one row per credential so each can be rotated, disabled and
  // cooled down on its own. Everything below returns ProviderKeyView: the
  // plaintext is write-only, never readable through the API after it is saved.

  /** List a provider's keys, ordered the way the gateway will try them. */
  async listKeys(name: string): Promise<ProviderKeyView[]> {
    const provider = await this.requireProvider(name)
    const keys = await this.prisma.providerApiKey.findMany({
      where: { providerId: provider.id },
      orderBy: [{ priority: 'asc' }, { id: 'asc' }],
    })
    return keys.map(toKeyView)
  }

  /**
   * Add a key. The plaintext is encrypted immediately and only its masked form
   * and hash are retained in a readable shape.
   *
   * A duplicate (same key already on this provider) is REFUSED: silently
   * accepting it would make rotation a no-op — every slot holding one exhausted
   * credential, which looks like "rotation is broken" rather than a config error.
   */
  async addKey(
    name: string,
    input: { key: string; label?: string; priority?: number },
  ): Promise<ProviderKeyView> {
    const provider = await this.requireProvider(name)
    const plaintext = (input.key ?? '').trim()
    if (plaintext.length < 8) {
      throw new BadRequestException(
        'API key looks too short — paste the full key from the provider',
      )
    }
    const keyHash = hashKey(plaintext)
    const existing = await this.prisma.providerApiKey.findUnique({
      where: { providerId_keyHash: { providerId: provider.id, keyHash } },
    })
    if (existing) {
      throw new ConflictException(
        `That API key is already configured for "${name}" (key #${existing.id}). ` +
          `Add a DIFFERENT key to enable rotation.`,
      )
    }

    const count = await this.prisma.providerApiKey.count({
      where: { providerId: provider.id },
    })
    const created = await this.prisma.providerApiKey.create({
      data: {
        providerId: provider.id,
        label: (input.label ?? '').trim() || `Key ${count + 1}`,
        encryptedKey: this.seal(plaintext),
        keyHash,
        maskedKey: maskSecret(plaintext),
        priority: input.priority ?? count,
        enabled: true,
        status: 'active',
      },
    })
    // Audit with the MASK only — an audit trail must never become a key leak.
    this.logger.log(
      `provider key added provider=${name} key=#${created.id} label=${created.label} mask=${created.maskedKey}`,
    )
    return toKeyView(created)
  }

  /**
   * Replace a key's secret in place, keeping its id/label/priority. Status resets
   * to active because the new credential deserves a fresh chance — a key marked
   * invalid stays unused forever otherwise.
   */
  async replaceKey(
    name: string,
    keyId: number,
    plaintextRaw: string,
  ): Promise<ProviderKeyView> {
    const provider = await this.requireProvider(name)
    const key = await this.requireKey(provider.id, keyId)
    const plaintext = (plaintextRaw ?? '').trim()
    if (plaintext.length < 8) {
      throw new BadRequestException(
        'API key looks too short — paste the full key from the provider',
      )
    }
    const keyHash = hashKey(plaintext)
    const clash = await this.prisma.providerApiKey.findUnique({
      where: { providerId_keyHash: { providerId: provider.id, keyHash } },
    })
    if (clash && clash.id !== key.id) {
      throw new ConflictException(
        `That API key is already configured for "${name}" (key #${clash.id}).`,
      )
    }
    const updated = await this.prisma.providerApiKey.update({
      where: { id: key.id },
      data: {
        encryptedKey: this.seal(plaintext),
        keyHash,
        maskedKey: maskSecret(plaintext),
        status: 'active',
        cooldownUntil: null,
        lastError: null,
      },
    })
    this.logger.log(
      `provider key replaced provider=${name} key=#${updated.id} mask=${updated.maskedKey}`,
    )
    return toKeyView(updated)
  }

  /** Enable/disable a key, or renumber its rotation priority. */
  async updateKey(
    name: string,
    keyId: number,
    patch: { label?: string; enabled?: boolean; priority?: number },
  ): Promise<ProviderKeyView> {
    const provider = await this.requireProvider(name)
    const key = await this.requireKey(provider.id, keyId)
    const data: {
      label?: string
      priority?: number
      enabled?: boolean
      status?: ProviderKeyStatus
      cooldownUntil?: null
      lastError?: null
    } = {}
    if (patch.label !== undefined && patch.label.trim()) data.label = patch.label.trim()
    if (patch.priority !== undefined) data.priority = patch.priority
    if (patch.enabled !== undefined) {
      data.enabled = patch.enabled
      // Re-enabling clears a stale cooldown/error so the key is retried at once;
      // disabling records the state explicitly so the dashboard reads correctly.
      if (patch.enabled) {
        data.status = 'active'
        data.cooldownUntil = null
        data.lastError = null
      } else {
        data.status = 'disabled'
      }
    }
    const updated = await this.prisma.providerApiKey.update({
      where: { id: key.id },
      data,
    })
    this.logger.log(
      `provider key updated provider=${name} key=#${updated.id} enabled=${updated.enabled} priority=${updated.priority} status=${updated.status}`,
    )
    return toKeyView(updated)
  }

  /** Delete a key. */
  async removeKey(name: string, keyId: number): Promise<{ deleted: true }> {
    const provider = await this.requireProvider(name)
    const key = await this.requireKey(provider.id, keyId)
    await this.prisma.providerApiKey.delete({ where: { id: key.id } })
    this.logger.warn(
      `provider key deleted provider=${name} key=#${key.id} mask=${key.maskedKey}`,
    )
    return { deleted: true }
  }

  /**
   * Encrypt a key, translating a missing/short master secret into an actionable
   * 400 instead of a 500 with a stack trace.
   */
  private seal(plaintext: string): string {
    try {
      return encryptSecret(plaintext)
    } catch (e) {
      if (e instanceof ProviderSecretError) {
        throw new BadRequestException(e.message)
      }
      throw e
    }
  }

  private async requireProvider(name: string): Promise<Provider> {
    const provider = await this.findByName(name)
    if (!provider) throw new NotFoundException(`Unknown provider: ${name}`)
    return provider
  }

  private async requireKey(
    providerId: number,
    keyId: number,
  ): Promise<ProviderApiKey> {
    const key = await this.prisma.providerApiKey.findUnique({ where: { id: keyId } })
    // Scope the lookup to the provider in the URL so one provider's id space
    // can't be used to touch another's key.
    if (!key || key.providerId !== providerId) {
      throw new NotFoundException(`Unknown API key: ${keyId}`)
    }
    return key
  }

  // --- helpers ---------------------------------------------------------------

  private requireFormat(format: ProviderFormat | undefined): ProviderFormat {
    if (!format) {
      throw new BadRequestException(
        `format is required (one of: ${PROVIDER_FORMATS.join(', ')})`,
      )
    }
    if (!PROVIDER_FORMATS.includes(format)) {
      throw new BadRequestException(
        `Unknown format "${format}" (one of: ${PROVIDER_FORMATS.join(', ')})`,
      )
    }
    return format
  }

  private requireAuthScheme(scheme: ProviderAuthScheme): void {
    if (!PROVIDER_AUTH_SCHEMES.includes(scheme)) {
      throw new BadRequestException(
        `Unknown authScheme "${scheme}" (one of: ${PROVIDER_AUTH_SCHEMES.join(', ')})`,
      )
    }
  }

  private normalizeBaseUrl(raw: string): string {
    const trimmed = (raw ?? '').trim()
    return trimmed.endsWith('/') ? trimmed.replace(/\/+$/, '') : trimmed
  }

  private normalizePath(raw: string | null | undefined): string | null {
    if (raw === null || raw === undefined) return null
    const trimmed = raw.trim()
    return trimmed === '' ? null : trimmed
  }

  /**
   * Enforce the security rules on the fields the gateway acts on with a secret
   * in hand. Runs for create AND update so a later edit can't loosen a provider
   * that was created safely.
   */
  private assertSecure(input: {
    baseUrl: string
    endpointPath: string | null
  }): void {
    const allowInsecure = insecureBaseUrlsAllowed()
    const failure =
      validateBaseUrl(input.baseUrl, { allowInsecure }) ??
      validateEndpointPath(input.endpointPath)
    if (failure) throw new BadRequestException(failure.message)
  }
}
