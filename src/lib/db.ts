import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  prismaSchemaEnsured?: boolean
}

/**
 * Resolve the database connection URL.
 *
 * For Postgres (Vercel + Supabase): DATABASE_URL is a postgresql:// URL
 * set in the environment. We just pass it through to Prisma.
 *
 * For legacy SQLite (Railway): DATABASE_URL was file:/app/db/custom.db.
 * This is no longer supported after the Postgres migration — if you see
 * a file: URL here, the deployment is misconfigured.
 *
 * Build-time safety: if DATABASE_URL is not set (e.g. during `next build`
 * on Vercel before env vars are attached), we return a placeholder URL
 * that lets Prisma client generate but won't actually connect. Real
 * runtime errors will surface from Prisma itself with a clearer message.
 */
function resolveDatabaseUrl(): string {
  const envUrl = process.env.DATABASE_URL
  if (!envUrl) {
    // Build-time or misconfigured runtime — return placeholder so Prisma
    // client can be constructed without throwing during build collection.
    if (process.env.NEXT_PHASE === 'phase-production-build') {
      console.warn('[db] DATABASE_URL not set during build — using placeholder')
      return 'postgresql://placeholder:placeholder@placeholder:5432/placeholder'
    }
    // Real runtime without DATABASE_URL — throw with a helpful message
    throw new Error(
      'DATABASE_URL env var is required. Set it to a postgresql:// connection string (Supabase, Neon, etc.)',
    )
  }
  if (envUrl.startsWith('file:')) {
    throw new Error(
      'SQLite (file: URLs) is no longer supported. Migrate to Postgres by setting DATABASE_URL to a postgresql:// URL.',
    )
  }
  return envUrl
}

const databaseUrl = resolveDatabaseUrl()

// Use a single Prisma client per process (avoid exhausting connections in
// serverless environments like Vercel).
export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['error', 'warn'],
    datasources: {
      db: { url: databaseUrl },
    },
  })

// Cache the client across hot-reloads in dev
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db

/**
 * Ensure all required tables AND columns exist in the Postgres database.
 *
 * Why: Vercel serverless functions are stateless — there's no migration
 * step at deploy time. This function runs raw `CREATE TABLE IF NOT EXISTS`
 * SQL on first DB access, ensuring the tables always exist.
 *
 * Postgres notes:
 *   - Supports `ADD COLUMN IF NOT EXISTS` natively (unlike SQLite)
 *   - We query `information_schema.columns` instead of `PRAGMA table_info`
 *   - `DATETIME` becomes `TIMESTAMP` (Postgres naming)
 *   - `BOOLEAN NOT NULL DEFAULT false` works the same
 *
 * Idempotent: safe to call multiple times. The `prismaSchemaEnsured` flag
 * prevents re-running the SQL on every request within the same process.
 */
export async function ensureSchema(): Promise<void> {
  if (globalForPrisma.prismaSchemaEnsured) return
  globalForPrisma.prismaSchemaEnsured = true

  try {
    // CinemmCache table
    await db.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "CinemmCache" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "cacheKey" TEXT NOT NULL UNIQUE,
        "payload" TEXT NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)
    await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "CinemmCache_cacheKey_idx" ON "CinemmCache"("cacheKey")`)

    // ManualStreamUrl table
    await db.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "ManualStreamUrl" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "mediaId" TEXT NOT NULL,
        "mediaType" TEXT NOT NULL,
        "episodeId" TEXT,
        "shortlink" TEXT NOT NULL,
        "streamUrl" TEXT NOT NULL,
        "quality" TEXT NOT NULL,
        "format" TEXT NOT NULL,
        "host" TEXT NOT NULL,
        "fileName" TEXT NOT NULL,
        "fileSize" TEXT NOT NULL DEFAULT 'N/A',
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "expiresAt" TIMESTAMP(3) NOT NULL
      )
    `)
    await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ManualStreamUrl_mediaId_mediaType_episodeId_idx" ON "ManualStreamUrl"("mediaId", "mediaType", "episodeId")`)

    // MIGRATION: For existing tables created before episodeId/fileSize were
    // added. Postgres supports ADD COLUMN IF NOT EXISTS natively.
    await db.$executeRawUnsafe(`ALTER TABLE "ManualStreamUrl" ADD COLUMN IF NOT EXISTS "episodeId" TEXT`)
    await db.$executeRawUnsafe(`ALTER TABLE "ManualStreamUrl" ADD COLUMN IF NOT EXISTS "fileSize" TEXT NOT NULL DEFAULT 'N/A'`)

    // User and Post tables (from default schema — may not be used but kept for compat)
    await db.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "User" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "email" TEXT NOT NULL UNIQUE,
        "name" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)
    await db.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "Post" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "title" TEXT NOT NULL,
        "content" TEXT,
        "published" BOOLEAN NOT NULL DEFAULT false,
        "authorId" TEXT NOT NULL,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)

    // MIGRATION: Update all existing ManualStreamUrl entries to have
    // permanent expiry (year 9999). Previously they had 7-day TTL.
    try {
      const farFuture = new Date('9999-12-31T23:59:59.000Z')
      await db.$executeRawUnsafe(
        `UPDATE "ManualStreamUrl" SET "expiresAt" = $1 WHERE "expiresAt" < $1`,
        farFuture,
      )
    } catch {
      // Migration failed (e.g. table doesn't exist yet) — ignore, will retry next time
    }

    console.log('[db] Schema ensured — all tables and columns exist')
  } catch (e) {
    console.error('[db] ensureSchema failed:', e instanceof Error ? e.message : e)
    // Don't throw — let the request fail naturally if tables really are missing.
  }
}

// Auto-ensure schema on first DB access in production
// (skipped during build — NEXT_PHASE is set by Vercel/Next.js)
if (process.env.NODE_ENV === 'production' && process.env.NEXT_PHASE !== 'phase-production-build') {
  ensureSchema().catch(() => {})
}
