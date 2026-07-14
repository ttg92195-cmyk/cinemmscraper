/**
 * Test clicking the "Fetch Sources" button on the bot's reply.
 * Button data: "m:6611" (movie ID 6611)
 */

import { TelegramClient, Api } from 'telegram'
import { StringSession } from 'telegram/sessions/index.js'

const apiId = 38615831
const apiHash = '5b575a81ca360c0bb0bd98585c6afb6c'
const sessionStr = '1BQANOTEuMTA4LjU2LjE1OAG7dvEe85PnPC7JZCaKgYanVqVChzkVnC0dFdasiB93YSwyzrHvM3+R5p/tC6UgcHmPv1ouRAkA0wuaDAWF3aTOGcpPaglz86cgI7/avyZqzG2XAylK8K//YrjVMzL3LWnl2l1uMD3DRSEuk/DEBFdow/ct7+LIm5PVxULVfv0uC7NawCo+TxIe9QxhSWugPgosAWZuPNcX8ua2M6X9JbVfSj5t6Pc7N0roZ4sf6OmCZDHONJTaa/uNCpk7q2ODgLuXORraLTQLRtEcGy6GYy6UkiVHvdqNb007e2tbI+fH3YEeLaVBqFd1hZheI8pnb0j1/5Y5m5vfnq3Kbnx/RlLHZA=='

const client = new TelegramClient(
  new StringSession(sessionStr),
  apiId,
  apiHash,
  { connectionRetries: 5 },
)

await client.connect()
console.log('Connected:', client.connected)

const botUsername = 'cinemmbot'
const entity = await client.getEntity(botUsername)

// Get the last message from the bot (should be msg 4789 with the Fetch Sources button)
const recentMsgs = await client.getMessages(entity, { limit: 5 })
const botMsg = recentMsgs.find((m) => m.sender?.username === botUsername && m.replyMarkup)
if (!botMsg) {
  console.error('No bot message with buttons found!')
  await client.disconnect()
  process.exit(1)
}

console.log('Found bot msg:', botMsg.id)
console.log('Text:', botMsg.message)
console.log('Buttons:', JSON.stringify(botMsg.replyMarkup, null, 2))

// Get the last seen ID before clicking
const beforeClick = await client.getMessages(entity, { limit: 1 })
const lastSeenId = beforeClick[0]?.id ?? 0

// Click the "Fetch Sources" button (the first button in the first row)
const button = botMsg.replyMarkup.rows[0].buttons[0]
console.log(`\nClicking button "${button.text}" (data: ${Buffer.from(button.data).toString()})...`)

// Use getBotCallbackAnswer to "click" the button
try {
  const answer = await botMsg.click({ text: button.text })
  console.log('Button click answer:', JSON.stringify(answer, null, 2))
} catch (e) {
  console.error('Click failed (will poll for new messages anyway):', e?.message ?? e)
}

// Wait for the bot to respond to the click
console.log('\nWaiting for bot response after button click (up to 30s)...')
const deadline = Date.now() + 30000
let foundReply = null
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 2000))
  const newMsgs = await client.getMessages(entity, {
    minId: lastSeenId,
    limit: 10,
  })
  console.log(`Poll: found ${newMsgs.length} new message(s)`)
  for (const m of newMsgs) {
    const sender = m.sender
    const fromBot = sender && sender.username === botUsername
    console.log(`  - msg ${m.id} from ${sender?.username ?? sender?.id ?? 'unknown'} (bot=${fromBot}): "${(m.message ?? '').slice(0, 120)}..."`)
    if (fromBot && m.id !== botMsg.id) {
      foundReply = m
      break
    }
  }
  if (foundReply) break
}

if (foundReply) {
  console.log('\n========================================')
  console.log('BOT REPLY AFTER BUTTON CLICK:')
  console.log('========================================')
  console.log('Full text:', foundReply.message)
  console.log('')
  console.log('Buttons:', JSON.stringify(foundReply.replyMarkup, null, 2))
  console.log('Media:', JSON.stringify(foundReply.media, null, 2)?.slice(0, 500))

  // Extract URLs from text
  const textUrls = Array.from((foundReply.message ?? '').matchAll(/https?:\/\/[^\s<>"']+/g)).map((m) => m[0])
  console.log('\nURLs in text:', textUrls)

  // Extract URLs from buttons
  const buttonUrls = []
  if (foundReply.replyMarkup && 'rows' in foundReply.replyMarkup) {
    for (const row of foundReply.replyMarkup.rows) {
      for (const btn of row.buttons) {
        if ('url' in btn && btn.url) {
          buttonUrls.push({ text: btn.text, url: btn.url })
        }
      }
    }
  }
  console.log('URL buttons:', buttonUrls)
} else {
  console.log('\nNo new message after button click. The bot may have edited the original message instead.')

  // Check if the original message was edited
  console.log('\n=== Checking if original message was edited ===')
  const afterMsgs = await client.getMessages(entity, { limit: 3 })
  for (const m of afterMsgs) {
    console.log(`  - msg ${m.id} from ${m.sender?.username ?? 'unknown'} (editDate=${m.editDate}): "${(m.message ?? '').slice(0, 200)}..."`)
    console.log('    Buttons:', JSON.stringify(m.replyMarkup, null, 2)?.slice(0, 800))
  }
}

await client.disconnect()
process.exit(0)
