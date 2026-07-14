/**
 * Test script: send /start w_m_6611 to @cinemmbot and print the response.
 * Used to debug why the bot isn't replying with stream URLs.
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
console.log('Authorized:', await client.isUserAuthorized())

// Get the bot entity
const botUsername = 'cinemmbot'
console.log(`\nResolving @${botUsername}...`)
const entity = await client.getEntity(botUsername)
console.log('Bot entity:', JSON.stringify({
  id: entity.id?.toString(),
  username: entity.username,
  firstName: entity.firstName,
  bot: entity.bot,
}, null, 2))

// Get the last message ID before sending (so we can detect new messages)
const beforeMsgs = await client.getMessages(entity, { limit: 1 })
const lastSeenId = beforeMsgs.length > 0 ? beforeMsgs[0].id : 0
console.log(`\nLast seen message ID: ${lastSeenId}`)

// Send the message
const command = '/start w_m_6611'
console.log(`\nSending: "${command}" to @${botUsername}...`)
const sentMsg = await client.sendMessage(entity, { message: command })
console.log('Sent message ID:', sentMsg.id)

// Poll for reply
console.log('\nWaiting for bot reply (up to 30s)...')
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
    console.log(`  - msg ${m.id} from ${sender?.username ?? sender?.id ?? 'unknown'} (bot=${fromBot}): "${(m.message ?? '').slice(0, 80)}..."`)
    if (fromBot) {
      foundReply = m
      break
    }
  }
  if (foundReply) break
}

if (!foundReply) {
  console.log('\nNo reply from bot within 30s.')
} else {
  console.log('\n========================================')
  console.log('BOT REPLY:')
  console.log('========================================')
  console.log('Text:', foundReply.message)
  console.log('Buttons:', JSON.stringify(foundReply.replyMarkup, null, 2))
}

// Also fetch the most recent messages in the chat (just in case)
console.log('\n=== Most recent 5 messages in chat ===')
const recent = await client.getMessages(entity, { limit: 5 })
for (const m of recent) {
  console.log(`  - msg ${m.id} from ${m.sender?.username ?? m.sender?.id ?? 'unknown'}: "${(m.message ?? '').slice(0, 100)}..."`)
}

await client.disconnect()
process.exit(0)
