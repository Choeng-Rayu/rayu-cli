import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { OrganizationsModule } from '../organizations/organizations.module'
import { PromoModule } from '../promo/promo.module'
import { AppSettingsModule } from '../settings/app-settings.module'
import { UsersModule } from '../users/users.module'
import { AbaService } from './aba.service'
import { AbaTelegramListener } from './aba-telegram.listener'
import { BakongService } from './bakong.service'
import { PaymentsController } from './payments.controller'
import { PaymentsService } from './payments.service'
import { StripeService } from './stripe/stripe.service'

@Module({
  imports: [
    AuthModule,
    AppSettingsModule,
    UsersModule,
    PromoModule,
    // Team checkout: an org-owned payment seeds the team's credit pool on
    // confirmation instead of switching the payer's personal subscription.
    OrganizationsModule,
  ],
  controllers: [PaymentsController],
  // StripeService is the card rail's provider, registered here beside the other
  // two rails (Bakong, ABA) so PaymentsService owns the pricing and grant rules
  // for all three and the dependency graph stays one-way.
  providers: [
    BakongService,
    AbaService,
    StripeService,
    PaymentsService,
    AbaTelegramListener,
  ],
  exports: [PaymentsService, StripeService],
})
export class PaymentsModule {}
