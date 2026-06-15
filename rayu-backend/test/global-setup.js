// Jest globalSetup for e2e tests: create a clean schema in the MySQL test DB
// before the suite runs. Uses `prisma db push --force-reset` (no shadow DB
// required, no migration history needed for tests).
const { execSync } = require('child_process')

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'mysql://rayu:rayu_app_local@127.0.0.1:3306/rayu_test'

module.exports = async () => {
  process.env.DATABASE_URL = TEST_DATABASE_URL
  execSync('npx prisma db push --force-reset --skip-generate', {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL },
  })
}
