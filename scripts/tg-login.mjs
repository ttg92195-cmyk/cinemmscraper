/**
 * Telegram Login — SINGLE-STEP (for use inside this chat)
 * =====================================================
 *
 * ဒီ script ကို run ဖို့ Bro က phone number + SMS code ပေးရမယ်။
 * ဒါပေမဲ့ SMS code က Telegram ပို့ပြီးမှ ရမယ်လို့ ကြိုပြောထားတယ်။
 *
 * တကယ့် flow:
 *   Step A (code request):
 *     TG_PHONE=+959... node scripts/tg-login.mjs request
 *     → Telegram က SMS ပို့မယ်, phoneCodeHash ကို /tmp/tg_phonecodehash.txt ထဲ သိမ်းမယ်
 *
 *   Step B (sign-in with code):
 *     TG_PHONE=+959... node scripts/tg-login.mjs signin 12345
 *     → SMS code ကို သုံးပြီး sign in, session string ထုတ်ပေးမယ်
 */

import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { Api } from 'telegram'
import fs from 'fs'

const apiId = 38615831
const apiHash = '5b575a81ca360c0bb0bd98585c6afb6c'

const PHONE = process.env.TG_PHONE ?? ''
const MODE = process.argv[2] // "request" or "signin"
const SMS_CODE = process.argv[3] // only for "signin" mode
const PASSWORD_2FA = process.argv[4] // optional, only if 2FA enabled

if (!PHONE || !MODE) {
  console.error('Usage:')
  console.error('  Step A: TG_PHONE=+959... node scripts/tg-login.mjs request')
  console.error('  Step B: TG_PHONE=+959... node scripts/tg-login.mjs signin <SMS_CODE> [2FA_PASSWORD]')
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
  // Step A: ask Telegram to send an SMS code
  console.log(`Sending code request to ${PHONE}...`)
  try {
    const sent = await client.sendCodeRequest(PHONE)
    const phoneCodeHash = sent.phoneCodeHash
    fs.writeFileSync(STATE_FILE, JSON.stringify({ phone: PHONE, phoneCodeHash }, null, 2))
    console.log('')
    console.log('========================================')
    console.log('SMS CODE REQUESTED!')
    console.log('========================================')
    console.log('Telegram က phone ကို code ပို့မယ် (SMS သို့မဟုတ် Telegram app ထဲ)။')
    console.log('code ရပြီးတဲ့အခါ ဒီ command run ပါ:')
    console.log(`  TG_PHONE="${PHONE}" node scripts/tg-login.mjs signin <SMS_CODE>`)
    console.log('')
    console.log('(phoneCodeHash ကို file ထဲ သိမ်းပြီးသား — ပြန်ထည့်စရာ မလိုဘူး)')
  } catch (e) {
    console.error('Code request failed:', e instanceof Error ? e.message : e)
  }
} else if (MODE === 'signin') {
  // Step B: sign in with SMS code
  if (!SMS_CODE) {
    console.error('Usage: TG_PHONE=+959... node scripts/tg-login.mjs signin <SMS_CODE> [2FA_PASSWORD]')
    process.exit(1)
  }

  let state: { phone: string; phoneCodeHash: string }
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    console.error('ERROR: အရင် "request" mode ကို run ပါ။')
    process.exit(1)
  }

  if (state.phone !== PHONE) {
    console.error(`ERROR: phone မတူဘူး။ state ထဲက ${state.phone}, မင်းပေးတဲ့ ${PHONE}`)
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
    // If we got here, no 2FA needed
    const session = client.session.save()
    printSession(session)
  } catch (e: any) {
    const msg = e?.errorMessage ?? e?.message ?? String(e)
    if (msg.includes('SESSION_PASSWORD_NEEDED')) {
      console.log('2FA ပိတ်ထားတယ်။ password လိုတယ်။')
      if (!PASSWORD_2FA) {
        console.log('ဒီ command ကို password ထည့်ပြီး run ပါ:')
        console.log(`  TG_PHONE="${PHONE}" node scripts/tg-login.mjs signin ${SMS_CODE} <2FA_PASSWORD>`)
        process.exit(0)
      }
      // Try 2FA sign-in
      try {
        const pwdSrp = await client.invoke(new Api.account.GetPassword())
        const passwordSrpResult = await client.computeSrpParams(pwdSrp, PASSWORD_2FA)
        await client.invoke(
          new Api.auth.CheckPassword({ password: passwordSrpResult }),
        )
        const session = client.session.save()
        printSession(session)
      } catch (e2) {
        console.error('2FA login failed:', e2 instanceof Error ? e2.message : e2)
      }
    } else if (msg.includes('PHONE_CODE_EXPIRED')) {
      console.error('SMS code သက်တမ်းကုန်သွားပြီ (၂ မိနစ်ခန့်)။ request mode ကို ပြန် run ပါ။')
    } else if (msg.includes('PHONE_CODE_INVALID')) {
      console.error('SMS code မမှန်ဘူး။ ပြန်စစ်ပါ။')
    } else {
      console.error('Sign-in failed:', msg)
    }
  }
} else {
  console.error(`Unknown mode: ${MODE}. Use "request" or "signin".`)
}

await client.disconnect()
process.exit(0)

function printSession(session: string) {
  console.log('')
  console.log('========================================')
  console.log('=== LOGIN SUCCESSFUL! ===')
  console.log('========================================')
  console.log('')
  console.log('TELEGRAM_SESSION (ဒီ string အရှည်ကြီးကို ကူးပါ):')
  console.log('')
  console.log(session)
  console.log('')
  console.log('========================================')
  console.log('ဒီ string ကို Railway TELEGRAM_SESSION env var ထဲ ထည့်ပါ။')
  console.log('========================================')
}
