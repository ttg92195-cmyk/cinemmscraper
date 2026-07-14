/**
 * Telegram user client (gramjs) for fetching stream URLs from @cinemmbot.
 *
 * Strategy:
 *   1. Connect to Telegram using the pre-saved StringSession
 *   2. Send "/start w_m_<id>" (or "w_s_<id>" for series) to @cinemmbot
 *   3. Wait for the bot's response (text + inline buttons)
 *   4. Extract stream URLs from:
 *      - Message text (regex https?://...)
 *      - Inline button URLs (replyMarkup.rows[].buttons[].url)
 *   5. Cache the result for 7 days (separate cache key namespace)
 *   6. Disconnect
 *
 * Critical Railway patterns:
 *   - Request-scoped client (connect → query → disconnect every call)
 *     Long-lived MTProto sockets break when Railway redeploys.
 *   - 3-second rate limit between bot messages (avoid FloodWait)
 *   - FloodWait-aware retry: if Telegram says "wait N seconds", we wait.
 *
 * One-time setup:
 *   - Run `node scripts/telegram-login.mjs` locally
 *   - Set TELEGRAM_SESSION (the printed session string) as Railway env var
 *   - Also set TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_BOT_USERNAME
 */

import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { getCache, setCache } from '@/lib/cache'

const TG_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days — stream URLs change rarely
const TG_RATE_LIMIT_MS = 3000 // 3 seconds between bot messages
const TG_REPLY_TIMEOUT_MS = 15000 // wait up to 15s for bot reply

let lastBotMessageAt = 0

interface BotReply {
  text: string
  urls: string[]
  buttonUrls: string[]
}

/**
 * Connect to Telegram, send a deep-link to @cinemmbot, return the reply.
 * Returns null if anything goes wrong (no session, network error, timeout).
 */
export async function fetchStreamUrlsFromBot(
  deepLink: string,
): Promise<{ urls: string[]; raw: string; cached: boolean; error?: string }> {
  // 1. Check cache first — stream URLs are stable, cache aggressively
  const cacheKey = `tg:${deepLink}`
  const cached = await getCache<string[]>(cacheKey)
  if (cached && cached.length > 0) {
    return { urls: cached, raw: '(cached)', cached: true }
  }

  // 2. Verify env vars
  const apiId = parseInt(process.env.TELEGRAM_API_ID ?? '', 10)
  const apiHash = process.env.TELEGRAM_API_HASH
  const sessionStr = process.env.TELEGRAM_SESSION
  const botUsername = process.env.TELEGRAM_BOT_USERNAME ?? 'cinemmbot'

  if (!apiId || !apiHash || !sessionStr) {
    return {
      urls: [],
      raw: '',
      cached: false,
      error: 'TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_SESSION env var not set',
    }
  }

  // 3. Rate limit
  const sinceLast = Date.now() - lastBotMessageAt
  if (sinceLast < TG_RATE_LIMIT_MS) {
    await new Promise((r) => setTimeout(r, TG_RATE_LIMIT_MS - sinceLast))
  }

  // 4. Connect + send + receive + disconnect
  let client: TelegramClient | null = null
  try {
    client = new TelegramClient(
      new StringSession(sessionStr),
      apiId,
      apiHash,
      { connectionRetries: 3, timeout: TG_REPLY_TIMEOUT_MS },
    )
    await client.connect()
    if (!client.connected) {
      throw new Error('Failed to connect to Telegram')
    }

    // Send the deep-link command to the bot
    // /start w_m_6611 — same as clicking the deep link
    const startArg = deepLink.replace(/^.*start=/, '').replace(/\?.*$/, '')
    const command = `/start ${startArg}`.trim()

    const entity = await client.getEntity(botUsername)
    lastBotMessageAt = Date.now()
    await client.sendMessage(entity, { message: command })

    // Wait for the bot's reply — poll for new messages in the next 15s
    const reply = await waitForBotReply(client, entity.id.toString(), botUsername)

    if (!reply) {
      return {
        urls: [],
        raw: '',
        cached: false,
        error: `Bot @${botUsername} did not reply within ${TG_REPLY_TIMEOUT_MS / 1000}s`,
      }
    }

    // 5. Extract URLs from text + buttons
    const allUrls = [...new Set([...reply.urls, ...reply.buttonUrls])].filter(
      (u) => u.startsWith('http://') || u.startsWith('https://'),
    )

    // 6. Cache for 7 days
    if (allUrls.length > 0) {
      await setCache(cacheKey, allUrls)
    }

    return {
      urls: allUrls,
      raw: reply.text,
      cached: false,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown Telegram error'
    // Detect session-revoked errors so the user knows to re-login
    if (msg.includes('AUTH_KEY_UNREGISTERED') || msg.includes('SESSION_REVOKED')) {
      return {
        urls: [],
        raw: '',
        cached: false,
        error: 'Telegram session revoked — re-run scripts/telegram-login.mjs',
      }
    }
    // Detect FloodWait — surface the wait time so the caller can retry later
    const floodMatch = msg.match(/A wait of (\d+) seconds is required/i)
    if (floodMatch) {
      return {
        urls: [],
        raw: '',
        cached: false,
        error: `FloodWait: must wait ${floodMatch[1]}s before next message`,
      }
    }
    return { urls: [], raw: '', cached: false, error: msg }
  } finally {
    if (client) {
      try {
        await client.disconnect()
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Poll for the bot's reply. Returns the first new message from the bot
 * within the timeout window.
 */
async function waitForBotReply(
  client: TelegramClient,
  botEntityId: string,
  botUsername: string,
): Promise<BotReply | null> {
  const deadline = Date.now() + TG_REPLY_TIMEOUT_MS
  // Get current message count so we can detect the new one
  const messages = await client.getMessages(botEntityId, { limit: 1 })
  const lastSeenId = messages.length > 0 ? (messages[0].id ?? 0) : 0

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500)) // poll every 1.5s
    // Fetch any new messages since lastSeenId
    const newMsgs = await client.getMessages(botEntityId, {
      minId: lastSeenId,
      limit: 5,
    })
    // Find the first message from the bot itself
    const botMsg = newMsgs.find((m) => {
      const sender = m.sender
      if (!sender) return false
      const senderUsername = 'username' in sender ? sender.username : null
      return senderUsername === botUsername || sender.id?.toString() === botEntityId
    })
    if (botMsg) {
      const text = botMsg.message ?? ''
      // Extract URLs from text
      const textUrls = Array.from(text.matchAll(/https?:\/\/[^\s<>"']+/g)).map((m) => m[0])
      // Extract URLs from inline buttons
      const buttonUrls: string[] = []
      const replyMarkup = botMsg.replyMarkup
      if (replyMarkup && 'rows' in replyMarkup) {
        for (const row of replyMarkup.rows) {
          for (const button of row.buttons) {
            if ('url' in button && button.url) {
              buttonUrls.push(button.url)
            }
          }
        }
      }
      return { text, urls: textUrls, buttonUrls }
    }
  }
  return null
}

/**
 * Check if the Telegram session is alive. Used by /api/telegram-status.
 * Does NOT send any message — just verifies the connection works.
 */
export async function checkTelegramSession(): Promise<{
  connected: boolean
  error?: string
}> {
  const apiId = parseInt(process.env.TELEGRAM_API_ID ?? '', 10)
  const apiHash = process.env.TELEGRAM_API_HASH
  const sessionStr = process.env.TELEGRAM_SESSION

  if (!apiId || !apiHash || !sessionStr) {
    return { connected: false, error: 'Missing TELEGRAM_API_ID/HASH/SESSION env vars' }
  }

  let client: TelegramClient | null = null
  try {
    client = new TelegramClient(
      new StringSession(sessionStr),
      apiId,
      apiHash,
      { connectionRetries: 2, timeout: 10000 },
    )
    await client.connect()
    if (!client.connected) {
      return { connected: false, error: 'Failed to connect to Telegram' }
    }
    // Verify we're actually authorized (not just connected)
    const authorized = await client.isUserAuthorized()
    if (!authorized) {
      return { connected: false, error: 'Session not authorized — re-run login script' }
    }
    return { connected: true }
  } catch (e) {
    return {
      connected: false,
      error: e instanceof Error ? e.message : 'Unknown error',
    }
  } finally {
    if (client) {
      try {
        await client.disconnect()
      } catch {
        // ignore
      }
    }
  }
}
