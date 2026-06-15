import { Module } from '@nestjs/common'
import { PlansModule } from '../plans/plans.module'
import { UsersService } from './users.service'

@Module({
  imports: [PlansModule],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
