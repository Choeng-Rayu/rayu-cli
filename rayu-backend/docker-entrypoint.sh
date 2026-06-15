#!/bin/sh
set -e

# Apply pending Prisma migrations against MySQL, then boot the API. Plans are
# seeded idempotently on application startup (AppModule.onModuleInit).
echo "[rayu-backend] prisma migrate deploy..."
npx prisma migrate deploy

echo "[rayu-backend] starting API..."
exec node dist/main.js
