import 'reflect-metadata'
import { Logger, ValidationPipe } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: ['log', 'warn', 'error', 'debug', 'verbose'] })
  const logger = new Logger('HTTP')
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

  // Request logging
  app.use((req: { method: string; url: string }, _res: unknown, next: () => void) => {
    logger.log(`${req.method} ${req.url}`)
    next()
  })

  const port = config.get<number>('app.port', 4000)
  await app.listen(port)
  // eslint-disable-next-line no-console
  console.log(`rayu-backend listening on :${port}`)
}

void bootstrap()
