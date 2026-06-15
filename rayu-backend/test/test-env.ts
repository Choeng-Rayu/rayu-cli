// Runs in each jest worker before test modules load, so PrismaService connects
// to the test database rather than the dev/prod one.
process.env.NODE_ENV = 'test'
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'mysql://rayu:rayu_app_local@127.0.0.1:3306/rayu_test'
process.env.RAYU_JWT_SECRET = process.env.RAYU_JWT_SECRET || 'test-secret'
