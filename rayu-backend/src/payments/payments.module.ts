import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { BakongService } from './bakong.service'
import { PaymentsController } from './payments.controller'
import { PaymentsService } from './payments.service'

@Module({
  imports: [AuthModule],
  controllers: [PaymentsController],
  providers: [BakongService, PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
