import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { PrismaModule } from '../prisma/prisma.module'
import { TelegramController } from './telegram.controller'
import { TelegramService } from './telegram.service'

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [TelegramController],
  providers: [TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}
