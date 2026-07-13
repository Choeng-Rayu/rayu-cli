import { Module, OnModuleInit } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { AdminModule } from './admin/admin.module'
import { AuthModule } from './auth/auth.module'
import { AuthService } from './auth/auth.service'
import configuration from './config/configuration'
import { FeedbackModule } from './feedback/feedback.module'
import { HealthModule } from './health/health.module'
import { ModelsModule } from './models/models.module'
import { ModelsService } from './models/models.service'
import { PaymentsModule } from './payments/payments.module'
import { PlansModule } from './plans/plans.module'
import { PlansService } from './plans/plans.service'
import { PrismaModule } from './prisma/prisma.module'
import { PrismaService } from './prisma/prisma.service'
import { AppSettingsModule } from './settings/app-settings.module'
import { AppSettingsService } from './settings/app-settings.service'
import { TelegramModule } from './telegram/telegram.module'
import { UsageModule } from './usage/usage.module'
import { UsersModule } from './users/users.module'

const LOCAL_ADMIN_EMAIL = 'admin@rayucode.com'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    PrismaModule,
    HealthModule,
    PlansModule,
    ModelsModule,
    AppSettingsModule,
    UsersModule,
    AuthModule,
    UsageModule,
    FeedbackModule,
    AdminModule,
    PaymentsModule,
    TelegramModule,
  ],
})
export class AppModule implements OnModuleInit {
  constructor(
    private readonly plans: PlansService,
    private readonly models: ModelsService,
    private readonly settings: AppSettingsService,
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  // Idempotently ensure the plan catalog, hosted models, and global settings
  // exist on every boot (non-destructive; never overwrites admin edits).
  async onModuleInit(): Promise<void> {
    if (process.env.SKIP_PLAN_SEED === 'true') return
    await this.plans.seedDefaults()
    await this.models.seedDefaults()
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
