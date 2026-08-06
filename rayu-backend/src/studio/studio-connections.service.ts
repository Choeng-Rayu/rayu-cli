import { Injectable, NotFoundException } from '@nestjs/common'
import type { StudioConnection } from '@prisma/client'
import type { StudioConnectionKind } from '../common/enums'
import { encryptSecret, decryptSecret, maskSecret } from '../common/secretBox'
import { PrismaService } from '../prisma/prisma.service'

/**
 * What the API returns for a connection. Deliberately has no field that could
 * carry the token — the type itself is the guard against an accidental leak in a
 * future handler.
 */
export interface StudioConnectionView {
  kind: StudioConnectionKind
  maskedToken: string
  meta: Record<string, unknown> | null
  createdAt: Date
  updatedAt: Date
}

/**
 * Per-user credentials for the third-party services Rayu Studio integrates with.
 *
 * The plaintext token is sealed at rest and is only ever decrypted inside this
 * backend, immediately before an upstream call. It is never returned to the
 * browser, never logged, and never included in an error message.
 */
@Injectable()
export class StudioConnectionsService {
  constructor(private readonly prisma: PrismaService) {}

  static toView(row: StudioConnection): StudioConnectionView {
    return {
      kind: row.kind as StudioConnectionKind,
      maskedToken: row.maskedToken,
      meta: (row.meta as Record<string, unknown> | null) ?? null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  async list(userId: number): Promise<StudioConnectionView[]> {
    const rows = await this.prisma.studioConnection.findMany({
      where: { userId },
      orderBy: { kind: 'asc' },
    })
    return rows.map(StudioConnectionsService.toView)
  }

  /**
   * Store (or replace) a credential. Replacing rather than appending is
   * deliberate: two tokens for one service means every request has to guess
   * which is current.
   */
  async upsert(
    userId: number,
    kind: StudioConnectionKind,
    token: string,
    meta?: Record<string, unknown> | null,
  ): Promise<StudioConnectionView> {
    const value = token.trim()
    const data = {
      encryptedToken: encryptSecret(value),
      maskedToken: maskSecret(value),
      meta: (meta ?? undefined) as never,
    }
    const row = await this.prisma.studioConnection.upsert({
      where: { userId_kind: { userId, kind } },
      create: { userId, kind, ...data },
      update: data,
    })
    return StudioConnectionsService.toView(row)
  }

  async remove(userId: number, kind: StudioConnectionKind): Promise<void> {
    await this.prisma.studioConnection.deleteMany({ where: { userId, kind } })
  }

  /** Non-secret metadata for a connection, or null when not connected. */
  async meta(
    userId: number,
    kind: StudioConnectionKind,
  ): Promise<Record<string, unknown> | null> {
    const row = await this.prisma.studioConnection.findUnique({
      where: { userId_kind: { userId, kind } },
    })
    return (row?.meta as Record<string, unknown> | null) ?? null
  }

  /** Merge fields into a connection's cached metadata. No-op if not connected. */
  async mergeMeta(
    userId: number,
    kind: StudioConnectionKind,
    patch: Record<string, unknown>,
  ): Promise<void> {
    const current = (await this.meta(userId, kind)) ?? {}
    await this.prisma.studioConnection.updateMany({
      where: { userId, kind },
      data: { meta: { ...current, ...patch } as never },
    })
  }

  /**
   * Decrypt the user's token for an upstream call.
   *
   * Throws NotFoundException (404, "not connected") when absent so a controller
   * never has to distinguish "no row" from "bad row" — and so a missing
   * connection can't be mistaken for an auth failure on OUR api.
   *
   * The return value must not be logged, echoed, or placed in a response body.
   */
  async requireToken(
    userId: number,
    kind: StudioConnectionKind,
  ): Promise<string> {
    const row = await this.prisma.studioConnection.findUnique({
      where: { userId_kind: { userId, kind } },
    })
    if (!row) {
      throw new NotFoundException(
        `No ${kind} connection for this account. Connect ${kind} in Studio settings first.`,
      )
    }
    // A decryption failure means a wrong/rotated RAYU_PROVIDER_SECRET or a
    // tampered row. secretBox throws a message that names neither, which is what
    // we want to surface.
    return decryptSecret(row.encryptedToken)
  }

  /** True when the user has a credential for `kind`, without decrypting it. */
  async has(userId: number, kind: StudioConnectionKind): Promise<boolean> {
    const n = await this.prisma.studioConnection.count({ where: { userId, kind } })
    return n > 0
  }
}
