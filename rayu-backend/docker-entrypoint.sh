#!/bin/sh
set -e

# Apply pending Prisma migrations against MySQL, then boot the API. Plans are
# seeded idempotently on application startup (AppModule.onModuleInit).

# Wait until the DB accepts TCP connections (handles the DB still booting or
# briefly restarting — especially when the DB is a standalone Coolify resource
# rather than a compose service, so depends_on ordering gives no protection).
DB_HOST=$(node -e 'const u=new URL(process.env.DATABASE_URL);process.stdout.write(u.hostname)')
DB_PORT=$(node -e 'const u=new URL(process.env.DATABASE_URL);process.stdout.write(u.port||"3306")')
echo "[rayu-backend] waiting for db ${DB_HOST}:${DB_PORT} ..."
for i in $(seq 1 60); do
  nc -z "$DB_HOST" "$DB_PORT" 2>/dev/null && break
  echo "[rayu-backend] db not ready yet (attempt $i/60), retrying in 2s..."
  sleep 2
done
if ! nc -z "$DB_HOST" "$DB_PORT" 2>/dev/null; then
  echo "[rayu-backend] ERROR: db ${DB_HOST}:${DB_PORT} unreachable after 120s, aborting"
  exit 1
fi
echo "[rayu-backend] db is up"

echo "[rayu-backend] prisma migrate deploy..."
npx prisma migrate deploy

echo "[rayu-backend] starting API..."
exec node dist/main.js
