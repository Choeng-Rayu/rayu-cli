import { Injectable } from '@nestjs/common'
import type { Feedback } from '@prisma/client'
import type { FeedbackType } from '../common/enums'
import { PrismaService } from '../prisma/prisma.service'

@Injectable()
export class FeedbackService {
  constructor(private readonly prisma: PrismaService) {}

  create(
    userId: number,
    type: FeedbackType,
    message: string,
    rating: number | null,
  ): Promise<Feedback> {
    return this.prisma.feedback.create({
      data: { userId, type, message, rating },
    })
  }
}
