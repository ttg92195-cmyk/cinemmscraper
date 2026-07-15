import { PrismaClient } from '@prisma/client'

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
  prismaSchemaEnsured?: boolean
}

// Disable query logging in dev to reduce overhead (every cache read/write
// was being logged, which slows down the dev server noticeably).
export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ['error', 'warn'],
  })

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db

/**
 * Ensure all required tables exist in the SQLite database.
 *
 * Why: Railway's filesystem is ephemeral — the SQLite file resets on every
 * deploy (unless a persistent volume is mounted). Prisma's `db push` only
 * runs at build time, so the tables exist in the build image but get wiped
 * at runtime. This function runs raw `CREATE TABLE IF NOT EXISTS` SQL on
 * first DB access, ensuring the tables always exist.
 *
 * Idempotent: safe to call multiple times. The `prismaSchemaEnsured` flag
 * prevents re-running the SQL on every request.
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
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)
    await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "CinemmCache_cacheKey_idx" ON "CinemmCache"("cacheKey")`)

    // ManualStreamUrl table
    await db.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "ManualStreamUrl" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "mediaId" TEXT NOT NULL,
        "mediaType" TEXT NOT NULL,
        "shortlink" TEXT NOT NULL,
        "streamUrl" TEXT NOT NULL,
        "quality" TEXT NOT NULL,
        "format" TEXT NOT NULL,
        "host" TEXT NOT NULL,
        "fileName" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "expiresAt" DATETIME NOT NULL
      )
    `)
    await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS "ManualStreamUrl_mediaId_mediaType_idx" ON "ManualStreamUrl"("mediaId", "mediaType")`)

    // User and Post tables (from default schema — may not be used but kept for compat)
    await db.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "User" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "email" TEXT NOT NULL UNIQUE,
        "name" TEXT,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)
    await db.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "Post" (
        "id" TEXT NOT NULL PRIMARY KEY,
        "title" TEXT NOT NULL,
        "content" TEXT,
        "published" BOOLEAN NOT NULL DEFAULT false,
        "authorId" TEXT NOT NULL,
        "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `)

    console.log('[db] Schema ensured — all tables exist')
  } catch (e) {
    console.error('[db] ensureSchema failed:', e instanceof Error ? e.message : e)
    // Don't throw — let the request fail naturally if tables really are missing.
    // The error will be more descriptive from Prisma itself.
  }
}

// Auto-ensure schema on first DB access in production
if (process.env.NODE_ENV === 'production') {
  ensureSchema().catch(() => {})
}
