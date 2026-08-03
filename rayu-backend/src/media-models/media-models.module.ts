import { Module } from '@nestjs/common'
import { MediaModelsService } from './media-models.service'

@Module({
  providers: [MediaModelsService],
  exports: [MediaModelsService],
})
export class MediaModelsModule {}
