import 'reflect-metadata'
import { Logger, ValidationPipe } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import type { NestExpressApplication } from '@nestjs/platform-express'
import { json, raw, urlencoded } from 'express'
import { AppModule } from './app.module'

/**
 * Rayu Studio needs two exceptions to the default body handling:
 *
 *  • /api/studio/git-proxy must NOT be body-parsed. It relays git smart-HTTP
 *    packfiles, and a body parser that consumed the request stream would leave
 *    nothing to forward (and would buffer a whole clone into memory).
 *  • /api/studio/deploy carries a site's built files as JSON. Express's 100kb
 *    default rejects any real deploy.
 *
 *  • /api/payments/stripe/webhook must be parsed as a RAW Buffer, not JSON.
 *    Stripe signs the exact bytes of the body, and any re-serialization (which
 *    express.json performs) changes the bytes and invalidates the signature.
 *    express.raw captures the body as a Buffer so StripeService can verify it.
 *
 * Every other route keeps the historical 100kb limit — raising it globally would
 * widen the memory-exhaustion surface of the accounts API for no benefit.
 */
const GIT_PROXY_PREFIX = '/api/studio/git-proxy'
const DEPLOY_PREFIX = '/api/studio/deploy'
const STRIPE_WEBHOOK_PREFIX = '/api/payments/stripe/webhook'
const DEFAULT_BODY_LIMIT = '100kb'
const DEPLOY_BODY_LIMIT = '50mb'

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['log', 'warn', 'error', 'debug', 'verbose'],
    // Registered manually below so the studio's two exceptions can apply.
    bodyParser: false,
  })
  const logger = new Logger('HTTP')
  const config = app.get(ConfigService)

  app.use((req: { path: string }, res: unknown, next: () => void) => {
    if (req.path.startsWith(GIT_PROXY_PREFIX)) {
      next()
      return
    }
    if (req.path.startsWith(STRIPE_WEBHOOK_PREFIX)) {
      // Raw Buffer ONLY — the signature verifies the exact bytes. JSON parsing
      // here would re-serialize and break verification, so the webhook route
      // is excluded from the json() middleware entirely.
      raw({ type: 'application/json' })(req as never, res as never, next)
      return
    }
    const limit = req.path.startsWith(DEPLOY_PREFIX) ? DEPLOY_BODY_LIMIT : DEFAULT_BODY_LIMIT
    json({ limit })(req as never, res as never, next)
  })
  app.use((req: { path: string }, res: unknown, next: () => void) => {
    if (req.path.startsWith(GIT_PROXY_PREFIX) || req.path.startsWith(STRIPE_WEBHOOK_PREFIX)) {
      next()
      return
    }
    urlencoded({ extended: true, limit: DEFAULT_BODY_LIMIT })(req as never, res as never, next)
  })

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
