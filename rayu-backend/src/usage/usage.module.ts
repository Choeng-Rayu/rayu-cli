import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { UsersModule } from '../users/users.module'
import { UsageController } from './usage.controller'
import { UsageService } from './usage.service'

@Module({
  imports: [UsersModule, AuthModule],
  controllers: [UsageController],
  providers: [UsageService],
  exports: [UsageService],
})
export class UsageModule {}
