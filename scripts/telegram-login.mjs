/**
 * One-time login script for the Telegram user client (gramjs).
 *
 * Usage:
 *   1. Get API_ID and API_HASH from https://my.telegram.org/apps
 *   2. Run: TELEGRAM_API_ID=12345 TELEGRAM_API_HASH=abc123 node scripts/telegram-login.mjs
 *   3. Enter phone number (with country code, e.g. +959XXXXXXXXX)
 *   4. Enter the SMS code Telegram sends you
 *   5. If 2FA is enabled, enter your password
 *   6. Copy the printed StringSession and set it as TELEGRAM_SESSION env var on Railway
 *
 * IMPORTANT:
 *   - Use a BURNER Telegram account, NOT your personal one.
 *   - gramjs/MTProto automation is a ToS gray area; keep request volume low.
 *   - The session string grants FULL access to the linked account — treat it
 *     like a password. Rotate it if it leaks.
 */

import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { input } from 'input'

const apiId = parseInt(process.env.TELEGRAM_API_ID ?? '', 10)
const apiHash = process.env.TELEGRAM_API_HASH

if (!apiId || !apiHash) {
  console.error('ERROR: Set TELEGRAM_API_ID and TELEGRAM_API_HASH env vars.')
  console.error('Get them from https://my.telegram.org/apps')
  process.exit(1)
}

console.log('=== Telegram Login (one-time setup) ===')
console.log('')

const phone = await input.text('Phone number (with country code, e.g. +959XXXXXXXXX): ')
console.log(`Logging in as ${phone}...`)

const client = new TelegramClient(
  new StringSession(''),
  apiId,
  apiHash,
  { connectionRetries: 5 },
)

await client.start({
  phoneNumber: async () => phone,
  password: async () => input.password('2FA password (leave empty if none): '),
  phoneCode: async () => input.text('SMS code: '),
  onError: (err) => console.error('Login error:', err),
})

const session = client.session.save()
console.log('')
console.log('=== Login successful! ===')
console.log('')
console.log('Your TELEGRAM_SESSION (set this as an env var on Railway):')
console.log('')
console.log(session)
console.log('')
console.log('Keep this secret — it grants full access to your Telegram account.')

await client.disconnect()
process.exit(0)
