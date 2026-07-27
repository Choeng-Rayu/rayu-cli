import { Module } from '@nestjs/common'
import { PrismaModule } from '../prisma/prisma.module'
import { ProvidersService } from './providers.service'

@Module({
  imports: [PrismaModule],
  providers: [ProvidersService],
  exports: [ProvidersService],
})
export class ProvidersModule {}
