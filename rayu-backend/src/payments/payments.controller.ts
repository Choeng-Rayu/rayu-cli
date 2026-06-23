import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common'
import type { User } from '@prisma/client'
import { RayuAuthGuard } from '../auth/rayu-auth.guard'
import { CurrentUser } from '../auth/current-user.decorator'
import { CreateKhqrDto } from './dto/create-khqr.dto'
import { CreateTopupDto } from './dto/create-topup.dto'
import { PaymentsService } from './payments.service'

@Controller('payments')
@UseGuards(RayuAuthGuard)
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('khqr')
  createKhqr(@CurrentUser() user: User, @Body() body: CreateKhqrDto) {
    return this.payments.createKhqr(user.id, body.planCode, body.method)
  }

  @Post('topup-khqr')
  createTopupKhqr(@CurrentUser() user: User, @Body() body: CreateTopupDto) {
    return this.payments.createTopupKhqr(user.id, body.credits, body.method)
  }

  @Get('mine')
  mine(
    @CurrentUser() user: User,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
  ) {
    return this.payments.getUserPayments(
      user.id,
      parseInt(page, 10) || 1,
      Math.min(parseInt(pageSize, 10) || 20, 100),
    )
  }

  @Get(':id/status')
  status(
    @Param('id', ParseIntPipe) id: number,
    @CurrentUser() user: User,
  ) {
    return this.payments.checkStatus(id, user.id)
  }
}
