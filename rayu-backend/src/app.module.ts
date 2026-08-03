import { Module, OnModuleInit } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { AdminModule } from './admin/admin.module'
import { AuthModule } from './auth/auth.module'
import { AuthService } from './auth/auth.service'
import configuration from './config/configuration'
import { FeedbackModule } from './feedback/feedback.module'
import { HealthModule } from './health/health.module'
import { MediaModelsModule } from './media-models/media-models.module'
import { MediaModelsService } from './media-models/media-models.service'
import { ModelsModule } from './models/models.module'
import { ModelsService } from './models/models.service'
import { OrganizationsModule } from './organizations/organizations.module'
import { PaymentsModule } from './payments/payments.module'
import { StripeWebhookModule } from './payments/stripe/stripe-webhook.module'
import { PlansModule } from './plans/plans.module'
import { PlansService } from './plans/plans.service'
import { PrismaModule } from './prisma/prisma.module'
import { PrismaService } from './prisma/prisma.service'
import { ProvidersModule } from './providers/providers.module'
import { ProvidersService } from './providers/providers.service'
import { AppSettingsModule } from './settings/app-settings.module'
import { AppSettingsService } from './settings/app-settings.service'
import { StudioModule } from './studio/studio.module'
import { TelegramModule } from './telegram/telegram.module'
import { UsageModule } from './usage/usage.module'
import { UsersModule } from './users/users.module'

const LOCAL_ADMIN_EMAIL = 'admin@rayucode.com'

/** Actionable message for a database that has not been migrated. */
const MISSING_SCHEMA_HINT =
  'The database schema is out of date: a table this build needs does not exist. ' +
  'Run "npx prisma migrate deploy" in rayu-backend (with DATABASE_URL pointing at ' +
  'this database) and start again. The rayu-gateway needs the same schema.'

/** Prisma P2021 = "table does not exist" (also matches MySQL error 1146). */
function isMissingTableError(e: unknown): boolean {
  const err = e as { code?: string; message?: string }
  return (
    err?.code === 'P2021' ||
    (typeof err?.message === 'string' && /does not exist|doesn't exist/i.test(err.message))
  )
}

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    PrismaModule,
    HealthModule,
    PlansModule,
    ModelsModule,
    MediaModelsModule,
    ProvidersModule,
    AppSettingsModule,
    UsersModule,
    AuthModule,
    OrganizationsModule,
    UsageModule,
    FeedbackModule,
    AdminModule,
    PaymentsModule,
    StripeWebhookModule,
    TelegramModule,
    StudioModule,
  ],
})
export class AppModule implements OnModuleInit {
  constructor(
    private readonly plans: PlansService,
    private readonly models: ModelsService,
    private readonly mediaModels: MediaModelsService,
    private readonly providers: ProvidersService,
    private readonly settings: AppSettingsService,
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  // Idempotently ensure the plan catalog and global settings exist on every boot
  // (non-destructive; never overwrites admin edits).
  //
  // The hosted CATALOG (providers + models) is deliberately NOT seeded by
  // default: it is admin-owned, so a fresh deployment starts EMPTY and the CLI
  // offers no hosted models until an admin adds a provider and a model in the
  // dashboard. Without this, a restart would keep re-creating the shipped
  // defaults an operator had intentionally removed or replaced.
  //
  // Set SEED_CATALOG=true to opt IN to the shipped defaults (useful for a brand
  // new dev database). The warn-only config audits always run, since they never
  // mutate and are how a broken provider row or a mis-mapped model gets noticed.
  async onModuleInit(): Promise<void> {
    if (process.env.SKIP_PLAN_SEED === 'true') return
    await this.plans.seedDefaults()
    try {
      if (process.env.SEED_CATALOG === 'true') {
        await this.providers.seedDefaults()
        await this.models.seedDefaults()
      } else {
        await this.providers.auditProviderConfig()
        await this.models.auditModelFamilyConsistency()
      }
      // The MEDIA catalog (image/video generation) seeds on FIRST boot even
      // without SEED_CATALOG. Unlike the hosted chat catalog it carries no
      // provider routing and no credential — it only names public third-party
      // models the user's OWN key calls — and the CLI has no hardcoded registry
      // to fall back on, so an empty table means image/video generation is simply
      // unavailable. A non-empty table is left alone (admin-owned) unless
      // SEED_CATALOG=true asks for the shipped defaults again.
      await this.mediaModels.seedIfEmpty(process.env.SEED_CATALOG === 'true')
      await this.mediaModels.auditMediaCatalog()
    } catch (e) {
      // A missing table means the schema was never migrated. Prisma's raw P2021
      // stack tells an operator nothing actionable, so translate it.
      if (isMissingTableError(e)) {
        throw new Error(
          `${MISSING_SCHEMA_HINT} (original: ${(e as { message?: string }).message ?? e})`,
        )
      }
      throw e
    }
    await this.settings.seedDefaults()
    await this.ensureLocalAdmin()
  }

  /**
   * Ensure a permanent local admin account (admin@rayucode.com) exists.
   * Password is read from LOCAL_ADMIN_PASSWORD env var on first creation.
   * If the account already exists, only re-hashes if LOCAL_ADMIN_PASSWORD
   * changed (detected by checking if env var is set and non-empty).
   * The account is never created with role < 'admin'.
   */
  private async ensureLocalAdmin(): Promise<void> {
    const password = process.env.LOCAL_ADMIN_PASSWORD
    if (!password) return // nothing to do — no credential configured

    const existing = await this.prisma.user.findUnique({
      where: { email: LOCAL_ADMIN_EMAIL },
    })
    const passwordHash = await this.auth.hashPassword(password)

    if (!existing) {
      await this.prisma.user.create({
        data: {
          email: LOCAL_ADMIN_EMAIL,
          displayName: 'Admin',
          role: 'admin',
          status: 'active',
          passwordHash,
        },
      })
    } else {
      // Always refresh hash so a password change in env takes effect on restart.
      await this.prisma.user.update({
        where: { id: existing.id },
        data: { role: 'admin', status: 'active', passwordHash },
      })
    }
  }
}
