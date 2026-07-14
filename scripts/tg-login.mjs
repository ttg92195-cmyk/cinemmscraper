/**
 * Telegram Login — SINGLE-STEP (gramjs v2)
 *
 * Step A (code request):
 *   TG_PHONE=+669... node scripts/tg-login.mjs request
 * Step B (sign-in with code):
 *   TG_PHONE=+669... node scripts/tg-login.mjs signin <SMS_CODE> [2FA_PASSWORD]
 *
 * gramjs v2 uses Api.auth.SendCode, Api.auth.SignIn, Api.auth.CheckPassword
 * directly. The client.sendCode() method is internal (takes apiCredentials).
 */

import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import fs from 'fs'

const apiId = 38615831
const apiHash = '5b575a81ca360c0bb0bd98585c6afb6c'

const PHONE = process.env.TG_PHONE ?? ''
const MODE = process.argv[2] // "request" or "signin"
const SMS_CODE = process.argv[3] // only for "signin" mode
const PASSWORD_2FA = process.argv[4] // optional, only if 2FA enabled

if (!PHONE || !MODE) {
  console.error('Usage:')
  console.error('  Step A: TG_PHONE=+669... node scripts/tg-login.mjs request')
  console.error('  Step B: TG_PHONE=+669... node scripts/tg-login.mjs signin <SMS_CODE> [2FA_PASSWORD]')
  process.exit(1)
}

const STATE_FILE = '/tmp/tg_login_state.json'

const client = new TelegramClient(
  new StringSession(''),
  apiId,
  apiHash,
  { connectionRetries: 5 },
)

await client.connect()

if (MODE === 'request') {
  console.log(`Sending code request to ${PHONE}...`)
  try {
    // Use the raw Api.auth.SendCode constructor
    // SendCode params: { phoneNumber, apiId, apiHash, settings }
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
    // result is Api.auth.SentCode, has phoneCodeHash
    const phoneCodeHash = result.phoneCodeHash
    const sentVia = result.type ? result.type.className : 'unknown'
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      phone: PHONE,
      phoneCodeHash,
      sentVia,
      timestamp: Date.now(),
    }, null, 2))
    console.log('')
    console.log('========================================')
    console.log('SMS CODE REQUESTED!')
    console.log('========================================')
    console.log(`Telegram sent the code via: ${sentVia}`)
    console.log('Check your phone (SMS or Telegram app).')
    console.log('')
    console.log('When you receive the code, run:')
    console.log(`  TG_PHONE="${PHONE}" node scripts/tg-login.mjs signin <SMS_CODE>`)
    console.log('')
    console.log('(phoneCodeHash saved to /tmp/tg_login_state.json)')
  } catch (e) {
    const msg = e?.errorMessage ?? e?.message ?? String(e)
    console.error('Code request failed:', msg)
    if (msg.includes('PHONE_NUMBER_BANNED')) {
      console.error('→ This number is banned from Telegram.')
    } else if (msg.includes('PHONE_NUMBER_INVALID')) {
      console.error('→ Phone number format is invalid. Use +<country><number>, e.g. +66931522278')
    } else if (msg.includes('FLOOD_WAIT')) {
      const m = msg.match(/(\d+)/)
      console.error(`→ Rate limited. Wait ${m?.[1] ?? 'N'} seconds before retrying.`)
    }
  }
} else if (MODE === 'signin') {
  if (!SMS_CODE) {
    console.error('Usage: TG_PHONE=+669... node scripts/tg-login.mjs signin <SMS_CODE> [2FA_PASSWORD]')
    process.exit(1)
  }

  let state
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    console.error('ERROR: Run "request" mode first.')
    process.exit(1)
  }

  if (state.phone !== PHONE) {
    console.error(`ERROR: phone mismatch. state has ${state.phone}, you provided ${PHONE}`)
    process.exit(1)
  }

  // Check code age — Telegram codes expire after ~2 min
  const ageMs = Date.now() - (state.timestamp ?? 0)
  if (ageMs > 5 * 60 * 1000) {
    console.error(`ERROR: phoneCodeHash is too old (${Math.floor(ageMs / 1000)}s). Re-run "request" mode.`)
    process.exit(1)
  }

  console.log(`Signing in with code ${SMS_CODE}...`)
  try {
    await client.invoke(
      new Api.auth.SignIn({
        phoneNumber: PHONE,
        phoneCode: SMS_CODE,
        phoneCodeHash: state.phoneCodeHash,
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
        console.log(`  TG_PHONE="${PHONE}" node scripts/tg-login.mjs signin ${SMS_CODE} <2FA_PASSWORD>`)
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
      console.error('SMS code expired. Re-run "request" mode.')
    } else if (msg.includes('PHONE_CODE_INVALID')) {
      console.error('SMS code is invalid. Double-check the digits.')
    } else {
      console.error('Sign-in failed:', msg)
    }
  }
} else {
  console.error(`Unknown mode: ${MODE}. Use "request" or "signin".`)
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
