import { Module } from '@nestjs/common'
import { AppSettingsService } from './app-settings.service'

@Module({
  providers: [AppSettingsService],
  exports: [AppSettingsService],
})
export class AppSettingsModule {}
