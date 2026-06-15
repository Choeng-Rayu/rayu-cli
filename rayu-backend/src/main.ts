import 'reflect-metadata'
import { ValidationPipe } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule)
  const config = app.get(ConfigService)

  // Global input validation: strip unknown props and reject bad payloads.
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )

  // CORS: allow the website origin to call the API from the browser.
  app.enableCors({
    origin: config.get<string>('app.webOrigin'),
    credentials: true,
  })

  // The reverse proxy routes /api/* to this service.
  app.setGlobalPrefix('api')

  const port = config.get<number>('app.port', 4000)
  await app.listen(port)
  // eslint-disable-next-line no-console
  console.log(`rayu-backend listening on :${port}`)
}

void bootstrap()
