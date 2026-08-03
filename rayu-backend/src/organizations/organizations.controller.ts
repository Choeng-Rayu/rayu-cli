import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common'
import type { User } from '@prisma/client'
import { CurrentUser } from '../auth/current-user.decorator'
import { RayuAuthGuard } from '../auth/rayu-auth.guard'
import {
  CreateJoinLinkDto,
  CreateOrganizationDto,
  InviteMemberDto,
  JoinRequestDto,
  SetMemberQuotaDto,
} from './dto'
import { OrgAdminGuard } from './org-admin.guard'
import { OrganizationsService } from './organizations.service'

/**
 * Team (organization) endpoints. Everything here requires a signed-in user;
 * admin-only routes additionally go through OrgAdminGuard, which resolves the
 * caller's role from the database rather than from their (up to an hour old)
 * JWT claim.
 *
 * Buying the team plan is NOT here — it goes through POST /payments/team-khqr so
 * the whole KHQR lifecycle (create, poll, renew, cancel) stays in one place.
 */
@Controller('organizations')
@UseGuards(RayuAuthGuard)
export class OrganizationsController {
  constructor(private readonly orgs: OrganizationsService) {}

  /** Create a team; the caller becomes its admin and first member. */
  @Post()
  create(@CurrentUser() user: User, @Body() body: CreateOrganizationDto) {
    return this.orgs.createOrganization(user.id, body)
  }

  /** Teams the caller belongs to (0 or 1 in this version). */
  @Get('mine')
  mine(@CurrentUser() user: User) {
    return this.orgs.listMine(user.id)
  }

  /**
   * Accept an invite. Deliberately NOT admin-guarded and not membership-guarded:
   * the invitee is not a member yet. The token is the authorization, and the
   * signed-in account's email must match the invited address.
   */
  @Post('invites/:token/accept')
  accept(@CurrentUser() user: User, @Param('token') token: string) {
    return this.orgs.acceptInvite(token, user.id)
  }

  // --- Shareable join link (request → admin approval) ------------------------
  //
  // These three routes are for people who are NOT members yet, so they are only
  // signed-in-guarded: the token says which team is being asked about, and the
  // answer is always a REQUEST, never a seat. They are declared before `:slug` so
  // "join" is not swallowed by the team-detail route.

  /** What the join landing page shows: the team's public identity + my status. */
  @Get('join/:token')
  joinPreview(@CurrentUser() user: User, @Param('token') token: string) {
    return this.orgs.previewJoinLink(token, user.id)
  }

  /** Ask to join. Creates a PENDING request for the admin to decide on. */
  @Post('join/:token/request')
  requestToJoin(
    @CurrentUser() user: User,
    @Param('token') token: string,
    @Body() body: JoinRequestDto,
  ) {
    return this.orgs.requestToJoin(token, user.id, body.message)
  }

  /** Withdraw my own pending request. */
  @Post('join/:token/cancel')
  cancelJoinRequest(@CurrentUser() user: User, @Param('token') token: string) {
    return this.orgs.cancelJoinRequest(token, user.id)
  }

  /** Team detail: roster + pool + subscription. Members see it; admins also see invites. */
  @Get(':slug')
  get(@CurrentUser() user: User, @Param('slug') slug: string) {
    return this.orgs.getForMember(slug, user.id)
  }

  /** Invite someone by email. Returns the accept URL (no mailer is wired yet). */
  @Post(':slug/invite')
  @UseGuards(OrgAdminGuard)
  invite(
    @CurrentUser() user: User,
    @Param('slug') slug: string,
    @Body() body: InviteMemberDto,
  ) {
    return this.orgs.invite(slug, user.id, body.email, body.role ?? 'member')
  }

  /** Revoke a pending invite. */
  @Delete(':slug/invite/:inviteId')
  @UseGuards(OrgAdminGuard)
  revokeInvite(
    @CurrentUser() user: User,
    @Param('slug') slug: string,
    @Param('inviteId', ParseIntPipe) inviteId: number,
  ) {
    return this.orgs.revokeInvite(slug, user.id, inviteId)
  }

  // --- Join link + approval queue (admin) ------------------------------------

  /**
   * Create or REGENERATE the team's shareable join link. Regenerating is how a
   * link that has already been shared is made to stop working, so it is the same
   * endpoint rather than a separate "rotate".
   */
  @Post(':slug/join-link')
  @UseGuards(OrgAdminGuard)
  createJoinLink(
    @CurrentUser() user: User,
    @Param('slug') slug: string,
    @Body() body: CreateJoinLinkDto,
  ) {
    return this.orgs.createJoinLink(slug, user.id, {
      role: body.role,
      // 0 is the explicit "never expires" choice; undefined takes the default.
      expiresInDays: body.expiresInDays === 0 ? null : body.expiresInDays,
    })
  }

  /** Turn the join link off. Requests already filed through it are kept. */
  @Delete(':slug/join-link')
  @UseGuards(OrgAdminGuard)
  revokeJoinLink(@CurrentUser() user: User, @Param('slug') slug: string) {
    return this.orgs.revokeJoinLink(slug, user.id)
  }

  /** Approve a join request — this is what actually creates the seat. */
  @Post(':slug/join-requests/:requestId/approve')
  @UseGuards(OrgAdminGuard)
  approveJoinRequest(
    @CurrentUser() user: User,
    @Param('slug') slug: string,
    @Param('requestId', ParseIntPipe) requestId: number,
  ) {
    return this.orgs.approveJoinRequest(slug, user.id, requestId)
  }

  /** Reject a join request (kept on record, so a repeat ask is visible). */
  @Post(':slug/join-requests/:requestId/reject')
  @UseGuards(OrgAdminGuard)
  rejectJoinRequest(
    @CurrentUser() user: User,
    @Param('slug') slug: string,
    @Param('requestId', ParseIntPipe) requestId: number,
  ) {
    return this.orgs.rejectJoinRequest(slug, user.id, requestId)
  }

  /** Remove a member (their bucket is zeroed; the audit row is kept). */
  @Delete(':slug/members/:userId')
  @UseGuards(OrgAdminGuard)
  removeMember(
    @CurrentUser() user: User,
    @Param('slug') slug: string,
    @Param('userId', ParseIntPipe) targetUserId: number,
  ) {
    return this.orgs.removeMember(slug, user.id, targetUserId)
  }

  /** Set a member's per-period credit quota. */
  @Patch(':slug/members/:userId/quota')
  @UseGuards(OrgAdminGuard)
  setQuota(
    @CurrentUser() user: User,
    @Param('slug') slug: string,
    @Param('userId', ParseIntPipe) targetUserId: number,
    @Body() body: SetMemberQuotaDto,
  ) {
    return this.orgs.setMemberQuota(slug, user.id, targetUserId, body.bucketQuota)
  }

  /** Give up your own seat. */
  @Post(':slug/leave')
  leave(@CurrentUser() user: User, @Param('slug') slug: string) {
    return this.orgs.leave(slug, user.id)
  }
}
