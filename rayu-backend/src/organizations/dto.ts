import {
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator'
import { ORG_ROLES, PLAN_CODES, type OrgRole, type PlanCode } from '../common/enums'

/**
 * Slug rules: lowercase letters, digits and single dashes, 3-64 chars. It is a
 * URL segment (/dashboard/team/<slug>) and a public identifier, so it is
 * validated here rather than sanitized silently — an admin should see "that
 * slug isn't allowed" instead of getting a different team address than they
 * typed.
 */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,62}[a-z0-9])$/

export class CreateOrganizationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(191)
  name!: string

  @IsString()
  @Matches(SLUG_RE, {
    message:
      'slug must be 3-64 chars, lowercase letters/digits/dashes, and cannot start or end with a dash',
  })
  slug!: string

  /**
   * Google Workspace hosted domain that auto-joins its members, with or without
   * the leading '@' ("company.com" and "@company.com" are both accepted and
   * stored normalized). Omit for an invite-only team.
   */
  @IsOptional()
  @IsString()
  @MaxLength(191)
  ssoDomain?: string
}

export class InviteMemberDto {
  @IsEmail()
  @MaxLength(320)
  email!: string

  @IsOptional()
  @IsIn(ORG_ROLES as unknown as string[])
  role?: OrgRole
}

export class SetMemberQuotaDto {
  /**
   * Per-period credits this member may spend from the pool. 0 = no personal
   * quota (the member can still draw on whatever the shared pool has left).
   */
  @IsInt()
  @Min(0)
  @Max(1_000_000_000)
  bucketQuota!: number
}

/**
 * Create/regenerate the team's shareable join link.
 *
 * `role` is what the requester gets ON APPROVAL — it is chosen by the admin here,
 * never by whoever opens the link. `expiresInDays` is capped at a year and
 * defaults to the service's 30 days; pass 0 for a link that never expires (an
 * explicit choice, so it cannot be one by accident).
 */
export class CreateJoinLinkDto {
  @IsOptional()
  @IsIn(ORG_ROLES as unknown as string[])
  role?: OrgRole

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  expiresInDays?: number
}

/** File a request to join through a link. */
export class JoinRequestDto {
  /**
   * Optional note the admin sees next to the request ("I'm the new contractor").
   * Length-capped to match the column so a long paste is rejected with a clear
   * message instead of being silently truncated.
   */
  @IsOptional()
  @IsString()
  @MaxLength(280)
  message?: string
}

export class CreateOrgCheckoutDto {
  @IsIn(PLAN_CODES as unknown as string[])
  planCode!: PlanCode

  @IsOptional()
  @IsIn(['aba', 'bakong'])
  method?: 'aba' | 'bakong'
}
