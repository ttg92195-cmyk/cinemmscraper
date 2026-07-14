import { NextResponse } from 'next/server'
import { checkTelegramSession } from '@/lib/telegram-cinemm'

export const runtime = 'nodejs'
export const maxDuration = 15

/**
 * GET /api/telegram-status
 *
 * Checks whether the Telegram user-client session is alive.
 * Does NOT send any message to the bot — just verifies the connection.
 *
 * Returns:
 *   { connected: true }                            — session is good
 *   { connected: false, error: "..." }             — session is bad or env vars missing
 *   { connected: false, error: "Not configured" }  — env vars not set
 */
export async function GET() {
  const apiId = process.env.TELEGRAM_API_ID
  const apiHash = process.env.TELEGRAM_API_HASH
  const sessionStr = process.env.TELEGRAM_SESSION

  if (!apiId || !apiHash || !sessionStr) {
    return NextResponse.json({
      connected: false,
      configured: false,
      error: 'Not configured — set TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION env vars',
      envVarsPresent: {
        apiId: !!apiId,
        apiHash: !!apiHash,
        session: !!sessionStr,
      },
    })
  }

  const result = await checkTelegramSession()
  return NextResponse.json({
    connected: result.connected,
    configured: true,
    error: result.error ?? null,
  })
}
