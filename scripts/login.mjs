/**
 * Telegram Login Script (one-time setup)
 * =====================================
 *
 * Bro: ဒီ file ကို မင်း local computer မှာ run ရမယ်။
 *
 * Steps:
 *   1. cd to this folder in terminal
 *   2. Run: TELEGRAM_API_ID=38615831 TELEGRAM_API_HASH=5b575a81ca360c0bb0bd98585c6afb6c node login.mjs
 *      (Windows PowerShell: $env:TELEGRAM_API_ID=38615831; $env:TELEGRAM_API_HASH="5b575a81ca360c0bb0bd98585c6afb6c"; node login.mjs)
 *   3. Enter phone number (with country code, e.g. +959XXXXXXXXX)
 *   4. Enter SMS code Telegram sends you
 *   5. If 2FA enabled, enter password
 *   6. Copy the printed session string
 *
 * IMPORTANT:
 *   - Use a BURNER Telegram account (real SIM, not VoIP)
 *   - The session string grants FULL access — keep it secret
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
console.log('API ID:', apiId)
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
  password: async () => input.password('2FA password (leave empty if none, press Enter): '),
  phoneCode: async () => input.text('SMS code (e.g. 12345): '),
  onError: (err) => console.error('Login error:', err),
})

const session = client.session.save()
console.log('')
console.log('========================================')
console.log('=== LOGIN SUCCESSFUL! ===')
console.log('========================================')
console.log('')
console.log('Your TELEGRAM_SESSION (copy this ENTIRE string):')
console.log('')
console.log(session)
console.log('')
console.log('========================================')
console.log('Copy the string above and paste it as TELEGRAM_SESSION env var on Railway.')
console.log('========================================')

await client.disconnect()
process.exit(0)
