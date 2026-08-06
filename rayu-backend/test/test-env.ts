// Runs in each jest worker before test modules load, so PrismaService connects
// to the test database rather than the dev/prod one.
process.env.NODE_ENV = 'test'
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'mysql://rayu:rayu_app_local@127.0.0.1:3306/rayu_test'
process.env.RAYU_JWT_SECRET = process.env.RAYU_JWT_SECRET || 'test-secret'
// Provider API keys are stored encrypted, so the suite needs a master key.
process.env.RAYU_PROVIDER_SECRET =
  process.env.RAYU_PROVIDER_SECRET || 'e2e-provider-master-secret-0123456789abcdef'
// The hosted catalog is admin-owned in production (no seeding by default), but
// the e2e suite asserts against the shipped default providers/models, so it opts
// in explicitly here.
process.env.SEED_CATALOG = 'true'
