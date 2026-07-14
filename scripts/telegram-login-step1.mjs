/**
 * Telegram Login Script — TWO-STEP VERSION (no local computer needed)
 * =================================================================
 *
 * Bro မှာ computer မလိုဘူး။ ဒီ script ကို ဒီ chat environment ထဲမှာပဲ run မယ်။
 *
 * Step 1: run `node scripts/telegram-login-step1.mjs`
 *   → script က Telegram ကို phone number ပို့မယ်
 *   → Telegram က SMS code ပို့မယ် (Bro ရဲ့ phone ကို)
 *   → script က "phone_code_hash" ကို ဖိုင်ထဲ သိမ်းမယ်
 *   → terminal မှာ "SMS စောင့်ပါ" လို့ ပြမယ်
 *
 * Step 2: Bro ဆီ SMS code ရပြီးတဲ့အခါ
 *   → run `node scripts/telegram-login-step2.mjs <SMS_CODE>`
 *   → script က code + phone_code_hash ကို သုံးပြီး login ပြီးကြောင်း confirm
 *   → session string ကို output ထုတ်ပေးမယ်
 *
 * ဒီ approach က computer မလိုဘူး — ကျွန်တော်တို့ environment ထဲမှာပဲ အားလုံး လုပ်လို့ရတယ်။
 */

import { TelegramClient } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'
import fs from 'fs'

const apiId = 38615831
const apiHash = '5b575a81ca360c0bb0bd98585c6afb6c'

// Bro ရဲ့ phone number — ဒီနေရာမှာ ပြင်ရမယ်
// ဥပမာ: +959123456789
const PHONE = process.env.TG_PHONE ?? ''

if (!PHONE) {
  console.error('ERROR: TG_PHONE env var ထည့်ပါ (ဥပမာ: TG_PHONE=+959123456789 node scripts/telegram-login-step1.mjs)')
  process.exit(1)
}

console.log('=== Telegram Login — Step 1 ===')
console.log('Phone:', PHONE)

const client = new TelegramClient(
  new StringSession(''),
  apiId,
  apiHash,
  { connectionRetries: 5 },
)

await client.connect()

// Send code request to Telegram — this triggers the SMS
const sentCode = await client.sendCodeRequest(PHONE)
const phoneCodeHash = sentCode.phoneCodeHash

console.log('Telegram ကို SMS code တောင်းပြီးပြီ။')
console.log('phoneCodeHash:', phoneCodeHash)
console.log('')
console.log('Bro — phone ကိုကြည့်ပါ။ Telegram က code (ဥပမာ: 12345) ပို့ပါမယ်။')
console.log('Code ရပြီဆိုရင် ဒီ command ကို run ပါ:')
console.log(`  TG_PHONE="${PHONE}" node scripts/telegram-login-step2.mjs <SMS_CODE> <PHONE_CODE_HASH>`)
console.log('')
console.log('phoneCodeHash ကိုလည်း မှတ်ထားပါ (ဒီမှာ ပြထားပြီ):')
console.log(phoneCodeHash)

// Save state to file for step 2
fs.writeFileSync('/tmp/tg_state.json', JSON.stringify({
  phone: PHONE,
  phoneCodeHash,
  apiId,
  apiHash,
}))

// Keep connection open — step 2 will reuse it (but since this is a new process,
// step 2 will need to reconnect using phoneCodeHash). For gramjs, we need
// signInWithPassword or signInBot for the second step. Actually, gramjs's
// sendCodeRequest returns phoneCodeHash, then we call client.invoke(
//   new functions.auth.SignIn({ phoneNumber, phoneCode, phoneCodeHash })
// )

await client.disconnect()
process.exit(0)
