import { Module } from '@nestjs/common'
import { PrismaModule } from '../prisma/prisma.module'
import { PromoService } from './promo.service'

@Module({
  imports: [PrismaModule],
  providers: [PromoService],
  exports: [PromoService],
})
export class PromoModule {}
