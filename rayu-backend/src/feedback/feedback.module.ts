import {
  Body,
  Controller,
  Module,
  Post,
  UseGuards,
} from '@nestjs/common'
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator'
import type { User } from '@prisma/client'
import { FEEDBACK_TYPES, type FeedbackType } from '../common/enums'
import { AuthModule } from '../auth/auth.module'
import { CurrentUser } from '../auth/current-user.decorator'
import { RayuAuthGuard } from '../auth/rayu-auth.guard'
import { FeedbackService } from './feedback.service'

export class CreateFeedbackDto {
  @IsIn(FEEDBACK_TYPES as unknown as string[])
  type!: FeedbackType

  @IsString()
  @MaxLength(5000)
  message!: string

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  rating?: number
}

@Controller('feedback')
@UseGuards(RayuAuthGuard)
export class FeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  @Post()
  async create(
    @CurrentUser() user: User,
    @Body() body: CreateFeedbackDto,
  ): Promise<{ ok: true; id: number }> {
    const saved = await this.feedback.create(
      user.id,
      body.type,
      body.message,
      body.rating ?? null,
    )
    return { ok: true, id: saved.id }
  }
}

@Module({
  imports: [AuthModule],
  controllers: [FeedbackController],
  providers: [FeedbackService],
})
export class FeedbackModule {}
