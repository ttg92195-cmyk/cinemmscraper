import { NextRequest, NextResponse } from 'next/server'
import { exec } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'

const execAsync = promisify(exec)

export const runtime = 'nodejs'
export const maxDuration = 60 // 1 minute — Railway trial has memory limits
// (was 300s but Railway free trial sometimes can't sustain that)

/**
 * POST /api/backup
 *
 * Triggers a manual database backup to the private GitHub backup repo.
 *
 * This endpoint exists because Railway's separate cron service can't see
 * the main web service's database volume. Instead, we expose this endpoint
 * on the main web service (which HAS the DB), and use a free external
 * cron service (like cron-job.org) to call it daily.
 *
 * Authentication: requires a secret token in the request body or
 * Authorization header. Set BACKUP_API_TOKEN env var on Railway to
 * control what token is required.
 *
 * Request:
 *   POST /api/backup
 *   Headers: { "Authorization": "Bearer <token>" }
 *   Body (optional): { "token": "<token>" }
 *
 * Response:
 *   {
 *     "ok": true,
 *     "message": "Backup completed successfully",
 *     "timestamp": "2026-07-19T04:00:00Z",
 *     "output": "..." // last 3KB of backup log
 *   }
 *
 * External cron setup (cron-job.org — free):
 *   URL: https://cinemmscraper-production.up.railway.app/api/backup
 *   Method: POST
 *   Headers: Authorization: Bearer <your-token>
 *   Schedule: Daily at 4:00 AM UTC (or whatever you prefer)
 */

const BACKUP_API_TOKEN = process.env.BACKUP_API_TOKEN

function authenticate(req: NextRequest, body: any): boolean {
  if (!BACKUP_API_TOKEN) {
    // No token configured — allow all (not recommended for production)
    return true
  }
  // Check Authorization header
  const authHeader = req.headers.get('authorization') || ''
  const headerToken = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : ''
  if (headerToken && headerToken === BACKUP_API_TOKEN) return true
  // Check body token
  if (body?.token && body.token === BACKUP_API_TOKEN) return true
  return false
}

export async function POST(req: NextRequest) {
  // Parse body (optional)
  let body: any = {}
  try {
    body = await req.json()
  } catch {
    // No body or invalid JSON — that's OK, we'll try header auth
  }

  // Authenticate
  if (!authenticate(req, body)) {
    return NextResponse.json(
      { ok: false, error: 'Unauthorized — invalid or missing token' },
      { status: 401 },
    )
  }

  // Verify the backup script exists
  const scriptPath = path.join(process.cwd(), 'scripts', 'backup-db.sh')
  if (!fs.existsSync(scriptPath)) {
    return NextResponse.json(
      { ok: false, error: `Backup script not found at ${scriptPath}` },
      { status: 500 },
    )
  }

  // Verify env vars are set
  const missingVars: string[] = []
  if (!process.env.BACKUP_GITHUB_TOKEN) missingVars.push('BACKUP_GITHUB_TOKEN')
  if (!process.env.BACKUP_GITHUB_REPO) missingVars.push('BACKUP_GITHUB_REPO')
  if (missingVars.length > 0) {
    return NextResponse.json(
      {
        ok: false,
        error: `Missing required env vars: ${missingVars.join(', ')}`,
      },
      { status: 500 },
    )
  }

  console.log('[/api/backup] Starting backup at', new Date().toISOString())

  try {
    // Make sure script is executable (in case file permissions were lost)
    await execAsync(`chmod +x ${scriptPath}`).catch(() => {})

    // Run the backup script
    // Capture stdout + stderr together, with a 50-second timeout
    // (maxDuration is 60s — leave 10s buffer for response)
    const { stdout, stderr } = await execAsync(`bash ${scriptPath}`, {
      timeout: 50000,
      maxBuffer: 1024 * 1024 * 5, // 5MB buffer for log output
    })

    const output = (stdout || '') + (stderr || '')
    console.log('[/api/backup] Output (last 2KB):', output.slice(-2000))

    // Parse success/failure from output
    const isSuccess = output.includes('✅ Backup pushed successfully') ||
                      output.includes('No changes to commit')
    const hasError = output.includes('ERROR:') || output.includes('❌')

    if (isSuccess && !hasError) {
      return NextResponse.json({
        ok: true,
        message: 'Backup completed successfully',
        timestamp: new Date().toISOString(),
        output: output.slice(-3000), // last 3KB of log
      })
    } else {
      return NextResponse.json(
        {
          ok: false,
          message: 'Backup script ran but did not report success',
          timestamp: new Date().toISOString(),
          output: output.slice(-3000),
        },
        { status: 500 },
      )
    }
  } catch (e: any) {
    console.error('[/api/backup] Failed:', e)
    const errorOutput = (e.stdout || '') + (e.stderr || '') || e.message || 'unknown error'
    return NextResponse.json(
      {
        ok: false,
        error: e.message || 'Backup failed',
        timestamp: new Date().toISOString(),
        output: (errorOutput || '').slice(-3000),
      },
      { status: 500 },
    )
  }
}

/**
 * GET /api/backup — returns backup configuration status (no secrets).
 * Useful for verifying the endpoint is up without triggering a backup.
 */
export async function GET(req: NextRequest) {
  return NextResponse.json({
    ok: true,
    endpoint: '/api/backup',
    method: 'POST',
    authRequired: !!BACKUP_API_TOKEN,
    envVarsConfigured: {
      BACKUP_GITHUB_TOKEN: !!process.env.BACKUP_GITHUB_TOKEN,
      BACKUP_GITHUB_REPO: process.env.BACKUP_GITHUB_REPO || null,
      BACKUP_API_TOKEN: !!BACKUP_API_TOKEN,
    },
    usage: {
      curl: `curl -X POST ${req.nextUrl.origin}/api/backup ` +
        (BACKUP_API_TOKEN ? `-H "Authorization: Bearer <your-token>"` : '') +
        ' -H "Content-Type: application/json" -d "{}"',
    },
  })
}
