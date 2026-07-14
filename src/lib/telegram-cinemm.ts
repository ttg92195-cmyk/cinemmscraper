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
 *
 * Flow (discovered by reverse-engineering @cinemmbot):
 *   1. Send "/start w_m_<id>" to @cinemmbot
 *   2. Bot replies with movie/series info + a "Fetch Sources" inline button
 *      (button data: "m:<id>" or "s:<id>")
 *   3. Click the "Fetch Sources" button — bot EDITS its original reply message
 *      to include stream URLs (NOT a new message!)
 *   4. Extract URLs from the edited message:
 *      - Button copyText fields (KeyboardButtonCopy) — the actual stream URLs
 *      - Button URL fields (KeyboardButtonUrl) — alternative links
 *      - Text URLs — fallback
 *
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

  // 4. Connect + send + click + read edited message + disconnect
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

    // Resolve the bot entity
    const entity = await client.getEntity(botUsername)

    // Send "/start w_m_<id>" (or w_s_<id>")
    const startArg = deepLink.replace(/^.*start=/, '').replace(/\?.*$/, '')
    const command = `/start ${startArg}`.trim()

    lastBotMessageAt = Date.now()
    await client.sendMessage(entity, { message: command })

    // Wait for the bot's initial reply (with the "Fetch Sources" button)
    const initialReply = await waitForBotReply(client, entity.id.toString(), botUsername)
    if (!initialReply) {
      return {
        urls: [],
        raw: '',
        cached: false,
        error: `Bot @${botUsername} did not reply within ${TG_REPLY_TIMEOUT_MS / 1000}s`,
      }
    }

    // If there are no buttons, the bot may have already returned the URLs
    // (some movies don't have a separate Fetch Sources step)
    if (!initialReply.replyMarkup || !('rows' in initialReply.replyMarkup)) {
      const urls = extractUrlsFromMessage(initialReply)
      if (urls.length > 0) await setCache(cacheKey, urls)
      return { urls, raw: initialReply.text, cached: false }
    }

    // Find the "Fetch Sources" button (callback button)
    let fetchButton: any = null
    for (const row of initialReply.replyMarkup.rows) {
      for (const btn of row.buttons) {
        if (btn.className === 'KeyboardButtonCallback' && /fetch|sources?|get/i.test(btn.text)) {
          fetchButton = btn
          break
        }
      }
      if (fetchButton) break
    }

    if (!fetchButton) {
      // No fetch button — extract URLs from whatever we have
      const urls = extractUrlsFromMessage(initialReply)
      if (urls.length > 0) await setCache(cacheKey, urls)
      return { urls, raw: initialReply.text, cached: false }
    }

    // Click the "Fetch Sources" button
    const beforeClickId = initialReply.id
    try {
      await initialReply.click({ text: fetchButton.text })
    } catch (e) {
      // click() may throw even on success — we'll check for edited message below
    }

    // Wait for the bot to EDIT the original message with stream URLs
    // (Bot doesn't send a new message — it edits the existing one)
    const editedReply = await waitForEditedMessage(
      client,
      entity.id.toString(),
      beforeClickId,
    )

    if (!editedReply) {
      return {
        urls: [],
        raw: initialReply.text,
        cached: false,
        error: 'Bot did not edit message with stream URLs after button click',
      }
    }

    // 5. Extract URLs from the edited message (button copyText + URL + text)
    const allUrls = extractUrlsFromMessage(editedReply)

    // 6. Cache for 7 days
    if (allUrls.length > 0) {
      await setCache(cacheKey, allUrls)
    }

    return {
      urls: allUrls,
      raw: editedReply.text,
      cached: false,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown Telegram error'
    if (msg.includes('AUTH_KEY_UNREGISTERED') || msg.includes('SESSION_REVOKED')) {
      return {
        urls: [],
        raw: '',
        cached: false,
        error: 'Telegram session revoked — re-run scripts/telegram-login.mjs',
      }
    }
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
 * Extract stream URLs from a Telegram message.
 * URLs can be in:
 *   1. KeyboardButtonCopy.copyText (button text contains "Tube 1 4K" etc.)
 *   2. KeyboardButtonUrl.url (URL buttons)
 *   3. Message text (regex https?://...)
 */
function extractUrlsFromMessage(msg: any): string[] {
  const urls: string[] = []

  // 1. Buttons
  if (msg.replyMarkup && 'rows' in msg.replyMarkup) {
    for (const row of msg.replyMarkup.rows) {
      for (const btn of row.buttons) {
        // KeyboardButtonCopy — has copyText (the actual URL)
        if (btn.copyText && typeof btn.copyText === 'string') {
          urls.push(btn.copyText)
        }
        // KeyboardButtonUrl — has url
        if (btn.url && typeof btn.url === 'string') {
          urls.push(btn.url)
        }
      }
    }
  }

  // 2. Message text (regex https?://...)
  if (msg.message) {
    const textUrls = Array.from(String(msg.message).matchAll(/https?:\/\/[^\s<>"']+/g)).map((m: RegExpMatchArray) => m[0])
    urls.push(...textUrls)
  }

  // Dedupe + filter valid URLs
  return [...new Set(urls)].filter(
    (u) => u.startsWith('http://') || u.startsWith('https://'),
  )
}

/**
 * Poll for the bot's reply. Returns the first new message from the bot
 * within the timeout window. Returns the full message object (not just text)
 * so the caller can click buttons on it.
 */
async function waitForBotReply(
  client: TelegramClient,
  botEntityId: string,
  botUsername: string,
): Promise<any | null> {
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
      return botMsg
    }
  }
  return null
}

/**
 * Wait for a specific message to be edited. Polls the message by ID and
 * checks if its editDate has changed (or if its content/buttons changed).
 *
 * @cinemmbot edits the original message (rather than sending a new one)
 * after the user clicks "Fetch Sources". So we watch the original message.
 */
async function waitForEditedMessage(
  client: TelegramClient,
  botEntityId: string,
  messageId: number,
): Promise<any | null> {
  const deadline = Date.now() + TG_REPLY_TIMEOUT_MS
  // Capture the original editDate (if any)
  const origMsgs = await client.getMessages(botEntityId, { ids: [messageId] })
  const origEditDate = origMsgs?.[0]?.editDate ?? 0
  const origButtonCount =
    origMsgs?.[0]?.replyMarkup && 'rows' in (origMsgs[0].replyMarkup ?? {})
      ? (origMsgs[0].replyMarkup as any).rows.length
      : 0

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500)) // poll every 1.5s
    // Fetch the message by ID
    const msgs = await client.getMessages(botEntityId, { ids: [messageId] })
    const msg = msgs?.[0]
    if (!msg) continue
    const editDate = msg.editDate ?? 0
    const buttonCount =
      msg.replyMarkup && 'rows' in (msg.replyMarkup ?? {})
        ? (msg.replyMarkup as any).rows.length
        : 0
    // Edited if: editDate changed, OR button count changed, OR new URLs appeared
    if (editDate > origEditDate || buttonCount !== origButtonCount) {
      return msg
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
