import { createParamDecorator, ExecutionContext } from '@nestjs/common'
import type { User } from '@prisma/client'
import type { AuthedRequest } from './rayu-auth.guard'

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): User | undefined => {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>()
    return req.user
  },
)
