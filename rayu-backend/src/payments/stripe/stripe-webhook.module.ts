import { Module } from '@nestjs/common'
import { PaymentsModule } from '../payments.module'
import { StripeWebhookController } from './stripe-webhook.controller'

/**
 * Separate module for the public Stripe webhook endpoint.
 *
 * Kept off PaymentsModule on purpose: PaymentsController has a class-level
 * RayuAuthGuard, and registering this controller there (or in PaymentsModule)
 * would let that guard reject Stripe's signed POSTs. This module declares
 * ONLY the webhook controller and imports PaymentsModule for the
 * PaymentsService + StripeService the dispatch needs — PrismaModule is global,
 * so it needs no import here.
 */
@Module({
  imports: [PaymentsModule],
  controllers: [StripeWebhookController],
})
export class StripeWebhookModule {}