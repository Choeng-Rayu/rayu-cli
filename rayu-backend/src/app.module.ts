import { Module, OnModuleInit } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { AdminModule } from './admin/admin.module'
import { AuthModule } from './auth/auth.module'
import configuration from './config/configuration'
import { FeedbackModule } from './feedback/feedback.module'
import { HealthModule } from './health/health.module'
import { PlansModule } from './plans/plans.module'
import { PlansService } from './plans/plans.service'
import { PrismaModule } from './prisma/prisma.module'
import { UsageModule } from './usage/usage.module'
import { UsersModule } from './users/users.module'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    PrismaModule,
    HealthModule,
    PlansModule,
    UsersModule,
    AuthModule,
    UsageModule,
    FeedbackModule,
    AdminModule,
  ],
})
export class AppModule implements OnModuleInit {
  constructor(private readonly plans: PlansService) {}

  // Idempotently ensure the plan catalog exists on every boot.
  async onModuleInit(): Promise<void> {
    if (process.env.SKIP_PLAN_SEED === 'true') return
    await this.plans.seedDefaults()
  }
}
