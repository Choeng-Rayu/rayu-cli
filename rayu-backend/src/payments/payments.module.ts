import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { PromoModule } from '../promo/promo.module'
import { AppSettingsModule } from '../settings/app-settings.module'
import { UsersModule } from '../users/users.module'
import { AbaService } from './aba.service'
import { AbaTelegramListener } from './aba-telegram.listener'
import { BakongService } from './bakong.service'
import { PaymentsController } from './payments.controller'
import { PaymentsService } from './payments.service'

@Module({
  imports: [AuthModule, AppSettingsModule, UsersModule, PromoModule],
  controllers: [PaymentsController],
  providers: [BakongService, AbaService, PaymentsService, AbaTelegramListener],
  exports: [PaymentsService],
})
export class PaymentsModule {}
