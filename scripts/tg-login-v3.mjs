/**
 * Telegram Login — TWO-PHASE with persistent session
 *
 * Phase 1 (request): connects to Telegram, sends code request, saves the
 *   pre-auth session string + phoneCodeHash to /tmp/tg_session_state.json
 *   Then disconnects.
 *
 * Phase 2 (signin): reads the saved pre-auth session, restores it (so we
 *   reconnect to the SAME data center with the SAME auth key), then invokes
 *   SignIn with the code. The phoneCodeHash from phase 1 is still valid
 *   because we're using the same session.
 *
 * Usage:
 *   Phase 1: TG_PHONE=+669... node scripts/tg-login-v3.mjs request
 *   Phase 2: TG_PHONE=+669... node scripts/tg-login-v3.mjs signin <CODE> [2FA_PWD]
 */

import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import fs from 'fs'

const apiId = 38615831
const apiHash = '5b575a81ca360c0bb0bd98585c6afb6c'

const PHONE = process.env.TG_PHONE ?? ''
const MODE = process.argv[2]
const SMS_CODE = process.argv[3]
const PASSWORD_2FA = process.argv[4]

if (!PHONE || !MODE) {
  console.error('Usage:')
  console.error('  Phase 1: TG_PHONE=+669... node scripts/tg-login-v3.mjs request')
  console.error('  Phase 2: TG_PHONE=+669... node scripts/tg-login-v3.mjs signin <CODE> [2FA_PWD]')
  process.exit(1)
}

const STATE_FILE = '/tmp/tg_session_state.json'

if (MODE === 'request') {
  // Phase 1: fresh connection, send code request, save session
  const client = new TelegramClient(
    new StringSession(''),
    apiId,
    apiHash,
    { connectionRetries: 5 },
  )
  await client.connect()

  console.log(`Sending code request to ${PHONE}...`)
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
    const phoneCodeHash = result.phoneCodeHash
    const sentVia = result.type ? result.type.className : 'unknown'

    // Save the pre-auth session + phoneCodeHash
    const preAuthSession = client.session.save()
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      phone: PHONE,
      phoneCodeHash,
      preAuthSession,
      sentVia,
      timestamp: Date.now(),
    }, null, 2))

    console.log('')
    console.log('========================================')
    console.log('CODE REQUESTED — check your Telegram app!')
    console.log('========================================')
    console.log(`Code sent via: ${sentVia}`)
    console.log('Pre-auth session saved. Phone code hash:', phoneCodeHash.slice(0, 20) + '...')
    console.log('')
    console.log('When you get the code, run:')
    console.log(`  TG_PHONE="${PHONE}" node scripts/tg-login-v3.mjs signin <CODE>`)
  } catch (e) {
    const msg = e?.errorMessage ?? e?.message ?? String(e)
    console.error('Code request failed:', msg)
    if (msg.includes('FLOOD_WAIT')) {
      const m = msg.match(/(\d+)/)
      console.error(`→ Rate limited. Wait ${m?.[1] ?? 'N'} seconds.`)
    }
  }
  await client.disconnect()
  process.exit(0)
}

if (MODE === 'signin') {
  if (!SMS_CODE) {
    console.error('Usage: TG_PHONE=+669... node scripts/tg-login-v3.mjs signin <CODE> [2FA_PWD]')
    process.exit(1)
  }

  let state
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    console.error('ERROR: Run "request" phase first.')
    process.exit(1)
  }

  if (state.phone !== PHONE) {
    console.error(`ERROR: phone mismatch. state has ${state.phone}, you provided ${PHONE}`)
    process.exit(1)
  }

  // Check code age — Telegram codes expire after ~2 min, but the session/auth key lasts longer
  const ageMs = Date.now() - (state.timestamp ?? 0)
  console.log(`State age: ${Math.floor(ageMs / 1000)}s`)

  // Restore the pre-auth session — this reconnects to the SAME data center
  // with the SAME auth key, so the phoneCodeHash is still valid.
  const client = new TelegramClient(
    new StringSession(state.preAuthSession),
    apiId,
    apiHash,
    { connectionRetries: 5 },
  )
  await client.connect()

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
        console.log(`  TG_PHONE="${PHONE}" node scripts/tg-login-v3.mjs signin ${SMS_CODE} <2FA_PASSWORD>`)
      } else {
        try {
          const pwdInfo = await client.invoke(new Api.account.GetPassword())
          const passwordSrp = await client.computeSrpParams(pwdInfo, PASSWORD_2FA)
          await client.invoke(new Api.auth.CheckPassword({ password: passwordSrp }))
          const session = client.session.save()
          printSession(session)
        } catch (e2) {
          console.error('2FA login failed:', e2?.errorMessage ?? e2?.message ?? String(e2))
        }
      }
    } else if (msg.includes('PHONE_CODE_EXPIRED')) {
      console.error('SMS code expired. Re-run "request" phase.')
    } else if (msg.includes('PHONE_CODE_INVALID')) {
      console.error('SMS code is invalid. Double-check the digits.')
    } else {
      console.error('Sign-in failed:', msg)
    }
  }
  await client.disconnect()
  process.exit(0)
}

console.error(`Unknown mode: ${MODE}. Use "request" or "signin".`)
process.exit(1)

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
