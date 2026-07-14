/**
 * Telegram Login — Step 2: Enter SMS code, get session string
 *
 * Usage:
 *   TG_PHONE=+959XXXXXXXXX node scripts/telegram-login-step2.mjs <SMS_CODE>
 *
 * After step 1, Telegram sent an SMS to Bro's phone with a code like "12345".
 * Bro enters that code here, and we use the saved phoneCodeHash to sign in.
 */

import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import { Api } from 'telegram'
import fs from 'fs'

const apiId = 38615831
const apiHash = '5b575a81ca360c0bb0bd98585c6afb6c'

const PHONE = process.env.TG_PHONE ?? ''
const SMS_CODE = process.argv[2] // first CLI argument

if (!PHONE || !SMS_CODE) {
  console.error('Usage: TG_PHONE=+959XXXXXXXXX node scripts/telegram-login-step2.mjs <SMS_CODE>')
  console.error('Example: TG_PHONE=+959123456789 node scripts/telegram-login-step2.mjs 12345')
  process.exit(1)
}

// Read state from step 1
let state: { phone: string; phoneCodeHash: string }
try {
  const raw = fs.readFileSync('/tmp/tg_state.json', 'utf8')
  state = JSON.parse(raw)
} catch {
  console.error('ERROR: Step 1 ကို မလုပ်ရသေးဘူး။ အရင် run ပါ:')
  console.error('  TG_PHONE=<your_phone> node scripts/telegram-login-step1.mjs')
  process.exit(1)
}

if (state.phone !== PHONE) {
  console.error(`ERROR: Phone mismatch. Step 1 used ${state.phone}, but you provided ${PHONE}`)
  process.exit(1)
}

console.log('=== Telegram Login — Step 2 ===')
console.log('Phone:', PHONE)
console.log('SMS code:', SMS_CODE)
console.log('Using phoneCodeHash from step 1:', state.phoneCodeHash)

const client = new TelegramClient(
  new StringSession(''),
  apiId,
  apiHash,
  { connectionRetries: 5 },
)

await client.connect()

try {
  // Sign in with the code + hash
  // gramjs's signInWithCode helper exists, but to be safe we use the raw API
  const result = await client.invoke(
    new Api.auth.SignIn({
      phoneNumber: PHONE,
      phoneCode: SMS_CODE,
      phoneCodeHash: state.phoneCodeHash,
    }),
  )

  console.log('Login successful!')

  const session = client.session.save()
  console.log('')
  console.log('========================================')
  console.log('=== TELEGRAM SESSION STRING ===')
  console.log('========================================')
  console.log('')
  console.log(session)
  console.log('')
  console.log('========================================')
  console.log('ဒီ string အရှည်ကြီးကို ကူးပြီး Railway မှာ TELEGRAM_SESSION env var ထည့်ပါ။')
  console.log('========================================')
} catch (e) {
  console.error('Login failed:', e instanceof Error ? e.message : e)

  // Common errors:
  // - "PHONE_CODE_EXPIRED": code သက်တမ်းကုန် (သာမန်အားဖြင့် 2 မိနစ်)
  // - "PHONE_CODE_INVALID": code မမှန်ဘူး
  // - "SESSION_PASSWORD_NEEDED": 2FA ပိတ်ထားတယ် — password လိုတယ်
  if (e instanceof Error && e.message.includes('SESSION_PASSWORD_NEEDED')) {
    console.log('')
    console.log('မင်း account မှာ 2FA ပိတ်ထားတယ်။ password လိုတယ်။')
    console.log('ဒီ script ကို run ပါ:')
    console.log(`  TG_PHONE="${PHONE}" node scripts/telegram-login-step3.mjs <2FA_PASSWORD>`)
  }
} finally {
  await client.disconnect()
  process.exit(0)
}
