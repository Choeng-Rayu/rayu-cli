import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app.module'
import { PlansService } from './plans/plans.service'

// Standalone seeder: `npm run seed`. AppModule.onModuleInit already seeds on
// boot, but this lets ops run it explicitly (e.g. as a one-off container job).
async function run(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule)
  try {
    const plans = app.get(PlansService)
    const result = await plans.seedDefaults()
    // eslint-disable-next-line no-console
    console.log(
      `Seeded ${result.length} plans:`,
      result.map((p) => `${p.code}=${p.availability}`).join(', '),
    )
  } finally {
    await app.close()
  }
}

void run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Seed failed:', err)
  process.exit(1)
})
