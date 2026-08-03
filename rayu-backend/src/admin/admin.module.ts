import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Module,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common'
import {
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator'
import {
  MEDIA_BACKENDS,
  MEDIA_CAPABILITIES,
  MEDIA_FAMILIES,
  MEDIA_TYPES,
  PLAN_AVAILABILITY,
  PLAN_CODES,
  PROVIDER_AUTH_SCHEMES,
  PROVIDER_FORMATS,
  USER_STATUSES,
  type MediaBackend,
  type MediaCapability,
  type MediaFamily,
  type MediaType,
  type PlanAvailability,
  type PlanCode,
  type ProviderAuthScheme,
  type ProviderFormat,
  type UserStatus,
} from '../common/enums'
import { sanitizeEntitlementsPatch } from '../common/features'
import { AuthModule } from '../auth/auth.module'
import { RayuAuthGuard } from '../auth/rayu-auth.guard'
import { Roles } from '../auth/roles.decorator'
import { RolesGuard } from '../auth/roles.guard'
import { MediaModelsModule } from '../media-models/media-models.module'
import { MediaModelsService } from '../media-models/media-models.service'
import { ModelsModule } from '../models/models.module'
import { ModelsService } from '../models/models.service'
import { PlansModule } from '../plans/plans.module'
import { ProvidersModule } from '../providers/providers.module'
import { ProvidersService } from '../providers/providers.service'
import { PromoModule } from '../promo/promo.module'
import { PaymentsModule } from '../payments/payments.module'
import { PaymentsService } from '../payments/payments.service'
import {
  DISCOUNT_TYPES,
  type DiscountType,
  PromoService,
} from '../promo/promo.service'
import { PrismaModule } from '../prisma/prisma.module'
import { AppSettingsModule } from '../settings/app-settings.module'
import { AppSettingsService } from '../settings/app-settings.service'
import { UsageModule } from '../usage/usage.module'
import { UsersModule } from '../users/users.module'
import { AdminService, AdminStats } from './admin.service'

export class UpdateUserStatusDto {
  @IsIn(USER_STATUSES as unknown as string[])
  status!: UserStatus
}

export class UpdateUserPlanDto {
  @IsIn(PLAN_CODES as unknown as string[])
  planCode!: PlanCode
}

export class BulkStatusDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  ids!: number[]

  @IsIn(USER_STATUSES as unknown as string[])
  status!: UserStatus
}

// All fields optional — admin patches only what changes. `features` is a free
// object validated/sanitized in the controller against the feature catalog.
export class UpdatePlanDto {
  @IsOptional()
  @IsString()
  @MaxLength(191)
  name?: string

  @IsOptional()
  @IsInt()
  @Min(0)
  priceCents?: number

  @IsOptional()
  @IsIn(PLAN_AVAILABILITY as unknown as string[])
  availability?: PlanAvailability

  // Allow null (= unlimited); when not null must be a non-negative int.
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(0)
  maxDailyTurns?: number | null

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(0)
  creditsPerPeriod?: number | null

  @IsOptional()
  @IsBoolean()
  topUpEnabled?: boolean

  @IsOptional()
  features?: Record<string, unknown>
}

// The full set of hosted models a plan may use. Absent codes are REVOKED, so the
// client must send the complete checklist state, not a delta — a delta would make
// two admins editing concurrently silently merge their choices.
export class SetPlanModelsDto {
  @IsArray()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  modelCodes!: string[]
}

class ModelFieldsDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  label?: string

  // The model's upstream provider, by registry id (providers table). Replaces
  // the old free-text `provider` + `upstreamBaseUrl` pair: base URL, wire
  // format, auth scheme, and key env now all live on the provider row.
  @IsOptional()
  @IsInt()
  @Min(1)
  providerId?: number

  @IsOptional()
  @IsString()
  @MaxLength(128)
  upstreamModelId?: string

  @IsOptional()
  @IsInt()
  @Min(0)
  inputPricePer1MCents?: number

  @IsOptional()
  @IsInt()
  @Min(0)
  outputPricePer1MCents?: number

  // --- Credit charges (credits per 1M tokens) --------------------------------
  // All four are admin-owned and used VERBATIM by the gateway; nothing is derived
  // from the cost prices above. Capped at 1000 so a slipped decimal can't bill a
  // customer 1000x. creditMultiplier is the INPUT charge (name kept because it is
  // the field already published to the CLI).
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000)
  creditMultiplier?: number

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000)
  outputCreditMultiplier?: number

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000)
  cacheReadCreditMultiplier?: number

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1000)
  cacheWriteCreditMultiplier?: number

  @IsOptional()
  @IsArray()
  @IsIn(PLAN_CODES as unknown as string[], { each: true })
  allowedPlanCodes?: string[]

  // Context window in TOKENS (e.g. 200000, 1000000). Explicit null clears it,
  // which makes the CLI fall back to its own default for the model. Capped at 20M
  // so a typo (extra zeros) can't make the CLI budget against an absurd window.
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(1000)
  @Max(20_000_000)
  contextWindow?: number | null

  // Per-model capabilities. The gateway rejects an image block (or a `thinking`
  // field) for a model whose flag is false BEFORE charging credits, and exposes
  // both flags to the CLI so it can warn the user to switch models.
  @IsOptional()
  @IsBoolean()
  supportsReasoning?: boolean

  @IsOptional()
  @IsBoolean()
  supportsImage?: boolean

  @IsOptional()
  @IsBoolean()
  supportsTools?: boolean

  @IsOptional()
  @IsBoolean()
  enabled?: boolean
}

export class CreateModelDto extends ModelFieldsDto {
  @IsString()
  @MaxLength(64)
  code!: string
}

export class UpdateModelDto extends ModelFieldsDto {}

// --- Media (image / video) generation catalog ---------------------------------
// The CLI's image/video model lists come from here (via the gateway), so this is
// the whole surface for "add a new image model" — no CLI release involved.
//
// SECURITY: metadata only. There is deliberately no key, no base URL, and no
// billing rate: the CLI calls NVIDIA / Vertex / fal directly with the USER's key.
class MediaModelFieldsDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  label?: string

  @IsOptional()
  @IsIn(MEDIA_TYPES as unknown as string[])
  mediaType?: MediaType

  // At least one capability, each valid for the media type (cross-checked in
  // MediaModelsService — an image model cannot claim "text2video").
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(MEDIA_CAPABILITIES as unknown as string[], { each: true })
  capabilities?: MediaCapability[]

  @IsOptional()
  @IsIn(MEDIA_BACKENDS as unknown as string[])
  backend?: MediaBackend

  // Constrained to the families the CLI actually has a request builder for: a
  // free-text family would create a catalog row no client can use.
  @IsOptional()
  @IsIn(MEDIA_FAMILIES as unknown as string[])
  family?: MediaFamily

  // NVCF function UUID (video on the `nvcf` backend). Explicit null clears it.
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(64)
  nvcfFunctionId?: string | null

  // Rough generation time for the CLI's wait message. Capped at an hour so a
  // typo can't tell users to wait a week.
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(1)
  @Max(3600)
  estimatedSeconds?: number | null

  // Per-model request defaults merged into the family body builder, e.g.
  // { "cfg_scale": 0, "steps": 4 }. Explicit null clears it.
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsObject()
  defaultParams?: Record<string, unknown> | null

  // EMPTY array = every plan (media generation is gated by the
  // image_generation / video_generation feature flags, not per-model).
  @IsOptional()
  @IsArray()
  @IsIn(PLAN_CODES as unknown as string[], { each: true })
  allowedPlanCodes?: string[]

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100_000)
  sortOrder?: number

  @IsOptional()
  @IsBoolean()
  enabled?: boolean
}

export class CreateMediaModelDto extends MediaModelFieldsDto {
  // Upstream ids are slash-paths (e.g. "fal-ai/kling-video/v2.1/standard/…"),
  // hence the wider limit than a chat model code.
  @IsString()
  @MaxLength(191)
  code!: string
}

export class UpdateMediaModelDto extends MediaModelFieldsDto {}

// --- Provider registry (admin-managed upstreams) ------------------------------
// SECURITY: there is deliberately NO apiKey field here. Keys are managed through
// the separate /admin/providers/:name/keys routes below, which encrypt on write
// and never return a secret. baseUrl/endpointPath are validated in
// ProvidersService (SSRF rules) and again by the gateway at route time.
class ProviderFieldsDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  label?: string

  @IsOptional()
  @IsIn(PROVIDER_FORMATS as unknown as string[])
  format?: ProviderFormat

  @IsOptional()
  @IsString()
  @MaxLength(255)
  baseUrl?: string

  // Explicit null = "clear the override, use the format default".
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(191)
  endpointPath?: string | null

  @IsOptional()
  @IsIn(PROVIDER_AUTH_SCHEMES as unknown as string[])
  authScheme?: ProviderAuthScheme


  @IsOptional()
  @IsBoolean()
  supportsReasoning?: boolean

  @IsOptional()
  @IsBoolean()
  supportsImage?: boolean

  @IsOptional()
  @IsBoolean()
  enabled?: boolean
}

export class CreateProviderDto extends ProviderFieldsDto {
  @IsString()
  @MaxLength(64)
  name!: string

  @IsIn(PROVIDER_FORMATS as unknown as string[])
  declare format: ProviderFormat

  @IsString()
  @MaxLength(255)
  declare baseUrl: string
}

export class UpdateProviderDto extends ProviderFieldsDto {}

// --- Provider API keys --------------------------------------------------------
// The key is WRITE-ONLY: it is accepted here, encrypted immediately, and never
// returned by any endpoint again (responses carry only a masked form).
export class AddProviderKeyDto {
  @IsString()
  @MaxLength(512)
  key!: string

  @IsOptional()
  @IsString()
  @MaxLength(64)
  label?: string

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(999)
  priority?: number
}

export class UpdateProviderKeyDto {
  /** Present = replace the secret in place (keeps id/label/priority). */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  key?: string

  @IsOptional()
  @IsString()
  @MaxLength(64)
  label?: string

  @IsOptional()
  @IsBoolean()
  enabled?: boolean

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(999)
  priority?: number
}

export class UpdateSettingsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  baselineCreditsPer1M?: number

  // Credit top-up rate: how many credits $1 buys. 0 = top-up unavailable. Capped
  // so a typo cannot hand out a practically infinite allowance.
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000_000)
  creditsPerDollar?: number

  // Smallest purchase in cents. Floor of 1¢ keeps the KHQR amount payable; the
  // product default is 100 (= $1).
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  minTopupCents?: number

  @IsOptional()
  @IsInt()
  @Min(0)
  maxConcurrentStreams?: number

  @IsOptional()
  @IsInt()
  @Min(0)
  maxTokensPerRequest?: number

  @IsOptional()
  @IsInt()
  @Min(0)
  maxRequestsPer5h?: number

  @IsOptional()
  @IsString()
  @MaxLength(64)
  baselineModelCode?: string

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  assumedInputRatio?: number

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  assumedUsagePercent?: number

  @IsOptional()
  @IsInt()
  @Min(0)
  infraCostCentsPerUser?: number
}

// Clawback of a paid top-up. `ref` is the payment-processor reference for the
// refund (ABA reversal id, Stripe refund id) recorded on the payment row.
export class RefundTopupDto {
  @IsOptional()
  @IsString()
  @MaxLength(191)
  ref?: string
}

// Promo/discount code CRUD. discountType percent (0-100) or fixed (cents off);
// appliesToPlans null/[] = all plans; maxRedemptions null = unlimited. Dates are
// ISO strings (or null); the service validates + parses them.
export class CreatePromoDto {
  @IsString()
  @MaxLength(64)
  code!: string

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(255)
  description?: string | null

  @IsIn(DISCOUNT_TYPES as unknown as string[])
  discountType!: DiscountType

  @IsInt()
  @Min(0)
  discountValue!: number

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsArray()
  @IsString({ each: true })
  appliesToPlans?: string[] | null

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(1)
  maxRedemptions?: number | null

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  startsAt?: string | null

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  endsAt?: string | null

  @IsOptional()
  @IsBoolean()
  active?: boolean
}

// All fields optional for PATCH (includes `active` for apply/end).
export class UpdatePromoDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  code?: string

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  @MaxLength(255)
  description?: string | null

  @IsOptional()
  @IsIn(DISCOUNT_TYPES as unknown as string[])
  discountType?: DiscountType

  @IsOptional()
  @IsInt()
  @Min(0)
  discountValue?: number

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsArray()
  @IsString({ each: true })
  appliesToPlans?: string[] | null

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(1)
  maxRedemptions?: number | null

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  startsAt?: string | null

  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  endsAt?: string | null

  @IsOptional()
  @IsBoolean()
  active?: boolean
}

// All admin routes require an active admin/superadmin session.
@Controller('admin')
@UseGuards(RayuAuthGuard, RolesGuard)
@Roles('admin', 'superadmin')
export class AdminController {
  constructor(
    private readonly admin: AdminService,
    private readonly models: ModelsService,
    // Image/video generation catalog. Codes are slash-paths, so the :code path
    // param must be URL-encoded by the caller (e.g.
    // black-forest-labs%2Fflux.1-schnell).
    private readonly mediaModels: MediaModelsService,
    private readonly settings: AppSettingsService,
    private readonly promo: PromoService,
    private readonly providers: ProvidersService,
    private readonly payments: PaymentsService,
  ) {}

  @Get('users')
  listUsers(
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
    @Query('search') search?: string,
    @Query('activity') activity?: string,
  ) {
    const act =
      activity === 'active' || activity === 'inactive' ? activity : undefined
    return this.admin.listUsers(
      parseInt(page, 10) || 1,
      parseInt(pageSize, 10) || 20,
      search,
      act,
    )
  }

  @Get('users/:id')
  getUserDetail(@Param('id', ParseIntPipe) id: number) {
    return this.admin.getUserDetail(id)
  }

  @Get('users/:id/payments')
  getUserPayments(
    @Param('id', ParseIntPipe) id: number,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
  ) {
    return this.admin.getUserPayments(
      id,
      parseInt(page, 10) || 1,
      parseInt(pageSize, 10) || 20,
    )
  }

  @Patch('users/:id/status')
  setStatus(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UpdateUserStatusDto,
  ) {
    return this.admin.setUserStatus(id, body.status)
  }

  @Patch('users/:id/plan')
  setUserPlan(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UpdateUserPlanDto,
  ) {
    return this.admin.setUserPlan(id, body.planCode)
  }

  @Get('payments')
  listAllPayments(
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
  ) {
    return this.admin.listAllPayments(
      parseInt(page, 10) || 1,
      parseInt(pageSize, 10) || 20,
    )
  }

  @Get('stats')
  stats(): Promise<AdminStats> {
    return this.admin.stats()
  }

  @Get('analytics')
  analytics(@Query('days') days?: string) {
    return this.admin.analytics(days ? parseInt(days, 10) : undefined)
  }

  @Get('feedback')
  listFeedback(
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
    @Query('type') type?: string,
  ) {
    return this.admin.listFeedback(
      parseInt(page, 10) || 1,
      parseInt(pageSize, 10) || 20,
      type,
    )
  }

  @Patch('users/bulk-status')
  bulkStatus(@Body() body: BulkStatusDto) {
    return this.admin.bulkSetStatus(body.ids, body.status)
  }

  // --- Plan / feature entitlement management ---

  @Get('plans')
  listPlans() {
    return this.admin.listPlans()
  }

  @Get('credit-projection')
  creditProjection() {
    return this.admin.creditProjection()
  }

  @Patch('plans/:code')
  async updatePlan(@Param('code') code: string, @Body() body: UpdatePlanDto) {
    // Sanitize the feature entitlements patch against the catalog (400 on bad
    // keys/limits) before handing to the service.
    let features
    if (body.features !== undefined) {
      try {
        features = sanitizeEntitlementsPatch(body.features)
      } catch (err) {
        throw new BadRequestException(
          err instanceof Error ? err.message : 'invalid features',
        )
      }
    }
    return this.admin.updatePlan(code, {
      name: body.name,
      priceCents: body.priceCents,
      availability: body.availability,
      maxDailyTurns: body.maxDailyTurns,
      creditsPerPeriod: body.creditsPerPeriod,
      topUpEnabled: body.topUpEnabled,
      features,
    })
  }

  // Model access is edited per PLAN here (a checklist), but stored per MODEL in
  // hosted_models.allowedPlanCodes. PUT replaces the whole set for this plan, in
  // one transaction — see AdminService.setPlanModels.
  @Put('plans/:code/models')
  setPlanModels(@Param('code') code: string, @Body() body: SetPlanModelsDto) {
    return this.admin.setPlanModels(code, body.modelCodes)
  }

  // --- Provider registry (admin-managed upstream providers) ---
  // Single source of truth for gateway routing: wire format, base URL, auth
  // scheme, and the NAME of the env var holding the key (never the key itself).

  @Get('providers')
  listProviders() {
    return this.providers.findAll()
  }

  @Post('providers')
  createProvider(@Body() body: CreateProviderDto) {
    return this.providers.create(body)
  }

  @Patch('providers/:name')
  updateProvider(
    @Param('name') name: string,
    @Body() body: UpdateProviderDto,
  ) {
    return this.providers.update(name, body)
  }

  @Delete('providers/:name')
  deleteProvider(@Param('name') name: string) {
    return this.providers.remove(name)
  }

  // --- Provider API keys ---
  // One row per key so each can rotate/cool down independently. Responses are
  // masked-only: the plaintext is never readable again once saved.

  @Get('providers/:name/keys')
  listProviderKeys(@Param('name') name: string) {
    return this.providers.listKeys(name)
  }

  @Post('providers/:name/keys')
  addProviderKey(@Param('name') name: string, @Body() body: AddProviderKeyDto) {
    return this.providers.addKey(name, body)
  }

  @Patch('providers/:name/keys/:id')
  updateProviderKey(
    @Param('name') name: string,
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UpdateProviderKeyDto,
  ) {
    // A body carrying `key` means "replace the secret"; anything else is a
    // metadata edit (label / enabled / priority).
    if (body.key !== undefined) {
      return this.providers.replaceKey(name, id, body.key)
    }
    return this.providers.updateKey(name, id, body)
  }

  @Delete('providers/:name/keys/:id')
  deleteProviderKey(
    @Param('name') name: string,
    @Param('id', ParseIntPipe) id: number,
  ) {
    return this.providers.removeKey(name, id)
  }

  // --- Hosted models (reseller catalog) ---

  @Get('models')
  listModels() {
    return this.models.findAll()
  }

  @Post('models')
  createModel(@Body() body: CreateModelDto) {
    return this.models.create(body)
  }

  @Patch('models/:code')
  updateModel(@Param('code') code: string, @Body() body: UpdateModelDto) {
    return this.models.update(code, body)
  }

  @Delete('models/:code')
  deleteModel(@Param('code') code: string) {
    return this.models.remove(code)
  }

  // --- Media (image / video) generation catalog ---
  // This is the CLI's source of truth for image/video models: adding a row here
  // makes the model appear in the CLI (next catalog refresh) with no release.

  @Get('media-models')
  listMediaModels() {
    return this.mediaModels.findAll()
  }

  @Post('media-models')
  createMediaModel(@Body() body: CreateMediaModelDto) {
    return this.mediaModels.create(body)
  }

  @Patch('media-models/:code')
  updateMediaModel(
    @Param('code') code: string,
    @Body() body: UpdateMediaModelDto,
  ) {
    return this.mediaModels.update(code, body)
  }

  @Delete('media-models/:code')
  deleteMediaModel(@Param('code') code: string) {
    return this.mediaModels.remove(code)
  }

  // --- Promo / discount codes ---

  @Get('promo-codes')
  listPromoCodes() {
    return this.promo.findAll()
  }

  @Post('promo-codes')
  createPromoCode(@Body() body: CreatePromoDto) {
    return this.promo.create(body)
  }

  @Patch('promo-codes/:id')
  updatePromoCode(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UpdatePromoDto,
  ) {
    return this.promo.update(id, body)
  }

  @Delete('promo-codes/:id')
  deletePromoCode(@Param('id', ParseIntPipe) id: number) {
    return this.promo.remove(id)
  }

  // --- Global credit settings ---

  @Get('credit-settings')
  getCreditSettings() {
    return this.settings.get()
  }

  @Patch('credit-settings')
  updateCreditSettings(@Body() body: UpdateSettingsDto) {
    return this.settings.update(body)
  }

  // --- Top-up refunds -----------------------------------------------------
  //
  // Claw back a paid top-up. ABA transfers are reversed out-of-band (there is no
  // webhook), so this is the operator's route to undo one; the Stripe
  // `charge.refunded` handler will call the same PaymentsService.refundTopup
  // when the card rail lands, keeping one clawback path for every rail.
  // Idempotent: replaying it reports clawedBack=false and writes nothing.
  @Post('payments/:id/refund-topup')
  refundTopup(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: RefundTopupDto,
  ) {
    return this.payments.refundTopup(id, body.ref)
  }
}

@Module({
  imports: [
    UsersModule,
    UsageModule,
    AuthModule,
    PrismaModule,
    PlansModule,
    ModelsModule,
    MediaModelsModule,
    ProvidersModule,
    AppSettingsModule,
    PromoModule,
    // For the top-up clawback endpoint: PaymentsService owns the single grant +
    // refund path, so admin reuses it rather than writing rows itself.
    PaymentsModule,
  ],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
