/**
 * Telegram Login — ALL-IN-ONE (for chat-based interactive use)
 *
 * ဒီ script က request နဲ့ signin ကို တစ် process တည်းမှာ လုပ်တယ်။
 * ဒါကြောင့် Telegram data center migrate ဖြစ်တဲ့အခါ phoneCodeHash ပါ
 * အတူဆက်သွားမယ်။
 *
 * Usage:
 *   TG_PHONE=+669... node scripts/tg-login-all.mjs <SMS_CODE>
 *
 * First, request a code (will prompt to run again with code):
 *   TG_PHONE=+669... node scripts/tg-login-all.mjs
 *
 * After receiving code via Telegram app, sign in:
 *   TG_PHONE=+669... node scripts/tg-login-all.mjs <SMS_CODE>
 */

import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import fs from 'fs'

const apiId = 38615831
const apiHash = '5b575a81ca360c0bb0bd98585c6afb6c'

const PHONE = process.env.TG_PHONE ?? ''
const SMS_CODE = process.argv[2] // optional; if absent, just request code
const PASSWORD_2FA = process.argv[3]

if (!PHONE) {
  console.error('Usage: TG_PHONE=+669... node scripts/tg-login-all.mjs [SMS_CODE] [2FA_PASSWORD]')
  console.error('  - Without SMS_CODE: just send code request')
  console.error('  - With SMS_CODE: sign in with code')
  process.exit(1)
}

const client = new TelegramClient(
  new StringSession(''),
  apiId,
  apiHash,
  { connectionRetries: 5 },
)

await client.connect()

// Step 1: Always send code request first (the hash is tied to this connection's DC)
console.log(`Sending code request to ${PHONE}...`)
let phoneCodeHash
try {
  const settings = new Api.CodeSettings({
    allowAppHash: true,
    allowMissedCall: true,
    allowFlashCall: true,
    currentNumber: true,
  })
  const result = await client.invoke(
    new Api.auth.SendCode({
      phoneNumber: PHONE,
      apiId,
      apiHash,
      settings,
    }),
  )
  phoneCodeHash = result.phoneCodeHash
  const sentVia = result.type ? result.type.className : 'unknown'
  console.log(`Code sent via: ${sentVia}`)
} catch (e) {
  const msg = e?.errorMessage ?? e?.message ?? String(e)
  console.error('Code request failed:', msg)
  if (msg.includes('FLOOD_WAIT')) {
    const m = msg.match(/(\d+)/)
    console.error(`→ Rate limited. Wait ${m?.[1] ?? 'N'} seconds.`)
  }
  await client.disconnect()
  process.exit(1)
}

// Step 2: If no SMS code provided, prompt user to provide one
if (!SMS_CODE) {
  console.log('')
  console.log('========================================')
  console.log('CODE REQUESTED — check your Telegram app!')
  console.log('========================================')
  console.log('When you have the code, run:')
  console.log(`  TG_PHONE="${PHONE}" node scripts/tg-login-all.mjs <SMS_CODE>`)
  console.log('')
  console.log('Note: the code & session are valid for ~2 minutes. Be quick!')
  await client.disconnect()
  process.exit(0)
}

// Step 3: Sign in with the code (using the SAME client connection — so DC is consistent)
console.log(`Signing in with code ${SMS_CODE}...`)
try {
  await client.invoke(
    new Api.auth.SignIn({
      phoneNumber: PHONE,
      phoneCode: SMS_CODE,
      phoneCodeHash,
    }),
  )
  const session = client.session.save()
  printSession(session)
} catch (e) {
  const msg = e?.errorMessage ?? e?.message ?? String(e)
  if (msg.includes('SESSION_PASSWORD_NEEDED')) {
    console.log('2FA is enabled. Password required.')
    if (!PASSWORD_2FA) {
      console.log('Run with password:')
      console.log(`  TG_PHONE="${PHONE}" node scripts/tg-login-all.mjs ${SMS_CODE} <2FA_PASSWORD>`)
    } else {
      try {
        const pwdInfo = await client.invoke(new Api.account.GetPassword())
        const passwordSrp = await client.computeSrpParams(pwdInfo, PASSWORD_2FA)
        await client.invoke(
          new Api.auth.CheckPassword({ password: passwordSrp }),
        )
        const session = client.session.save()
        printSession(session)
      } catch (e2) {
        console.error('2FA login failed:', e2?.errorMessage ?? e2?.message ?? String(e2))
      }
    }
  } else if (msg.includes('PHONE_CODE_EXPIRED')) {
    console.error('SMS code expired. Re-run this script (it will request a new code).')
  } else if (msg.includes('PHONE_CODE_INVALID')) {
    console.error('SMS code is invalid. Double-check the digits.')
  } else {
    console.error('Sign-in failed:', msg)
  }
}

await client.disconnect()
process.exit(0)

function printSession(session) {
  console.log('')
  console.log('========================================')
  console.log('=== LOGIN SUCCESSFUL! ===')
  console.log('========================================')
  console.log('')
  console.log('TELEGRAM_SESSION (copy this entire string):')
  console.log('')
  console.log(session)
  console.log('')
  console.log('========================================')
  console.log('Set this as TELEGRAM_SESSION env var on Railway.')
  console.log('========================================')
}
