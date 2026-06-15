import { Controller, Get, Module } from '@nestjs/common'

@Controller('health')
export class HealthController {
  @Get()
  check(): { status: string; service: string; time: string } {
    return {
      status: 'ok',
      service: 'rayu-backend',
      time: new Date().toISOString(),
    }
  }
}

@Module({ controllers: [HealthController] })
export class HealthModule {}
