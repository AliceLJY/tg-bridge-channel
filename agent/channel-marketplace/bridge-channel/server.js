#!/usr/bin/env bun
// Bridge channel server — 照官方 fakechat 蓝本写的最简 channel（加审批 capability）。
// claude 经 MCP 与本进程通信；本进程经 Unix socket 与 bridge adapter 通信。
//   inbound:  adapter --socket--> 这里 --notification(claude/channel)--> claude
//   reply:    claude --reply tool--> 这里 --socket--> adapter
//   approval: claude --permission_request notif--> 这里 --socket--> adapter
//             adapter --socket--> 这里 --notification(claude/channel/permission)--> claude
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import net from 'node:net'
import { createInterface } from 'node:readline'

const SOCK = process.env.BRIDGE_CHANNEL_SOCKET
if (!SOCK) { process.stderr.write('bridge-channel: BRIDGE_CHANNEL_SOCKET unset\n'); process.exit(1) }

// ---- side-channel 到 adapter（极简 JSONL，不依赖 bridge 其他文件）----
let sock = null
function toAdapter(obj) { try { if (sock) sock.write(JSON.stringify(obj) + '\n') } catch {} }

const mcp = new Server(
  { name: 'bridge-channel', version: '0.0.1' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {}, 'claude/channel/permission': {} } },
    instructions: [
      'The user reads a Telegram chat, not this transcript. Anything you want them to see must go through the reply tool.',
      'Inbound messages arrive as <channel> notifications. Reply with the reply tool — just pass text (files optional).',
    ].join('\n'),
  },
)

// claude → channel：要审批 → 转给 adapter（由真人在 TG 点 Allow/Deny）
mcp.setNotificationHandler(
  z.object({
    method: z.literal('notifications/claude/channel/permission_request'),
    params: z.object({ request_id: z.string(), tool_name: z.string(), description: z.string(), input_preview: z.string() }),
  }),
  async ({ params }) => toAdapter({ type: 'permission_request', ...params }),
)

// reply / edit_message tool：落到 socket，不发任何第三方服务
mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: 'Reply to the user. Pass text; optionally reply_to (message id) and files (absolute paths).',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          reply_to: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
        },
        required: ['text'],
      },
    },
    {
      name: 'edit_message',
      description: 'Edit a previously sent message (progress updates).',
      inputSchema: {
        type: 'object',
        properties: { message_id: { type: 'string' }, text: { type: 'string' } },
        required: ['message_id', 'text'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const a = req.params.arguments ?? {}
  if (req.params.name === 'reply') {
    toAdapter({ type: 'reply', text: String(a.text ?? ''), files: Array.isArray(a.files) ? a.files : [], reply_to: a.reply_to })
    return { content: [{ type: 'text', text: 'sent' }] }
  }
  if (req.params.name === 'edit_message') {
    toAdapter({ type: 'edit_message', message_id: a.message_id, text: a.text })
    return { content: [{ type: 'text', text: 'edited' }] }
  }
  return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
})

// 关键时序（MCP lifecycle）：await mcp.connect() 只代表 stdio transport 起来了，
// 不代表 claude 完成 initialize→initialized，更不代表 --channels 注册好了 client 端的
// notifications/claude/channel handler。太早发 notification 会被静默丢弃（claude 收不到）。
// 所以必须等 oninitialized + 一段延迟（让 --channels 注册 handler），再握手喂消息。
let resolveInitialized
const initialized = new Promise(res => { resolveInitialized = res })
mcp.onerror = e => process.stderr.write('bridge-channel: mcp error ' + (e?.stack || e) + '\n')
mcp.oninitialized = () => { resolveInitialized() }

await mcp.connect(new StdioServerTransport())
await initialized
await new Promise(r => setTimeout(r, Number(process.env.BRIDGE_CHANNEL_READY_DELAY_MS || 750)))

// 连 adapter 的 socket，收 adapter → channel 的指令（事件驱动，不用顶层 for await）
sock = net.connect(SOCK, () => toAdapter({ type: 'ready' }))
sock.on('error', e => process.stderr.write(`bridge-channel: socket err ${e}\n`))
const rl = createInterface({ input: sock })
rl.on('line', async (line) => {
  if (!String(line || '').trim()) return
  let m; try { m = JSON.parse(line) } catch { return }
  if (m.type === 'user_message') {
    await mcp.notification({ method: 'notifications/claude/channel', params: { content: m.content, meta: m.meta || {} } })
  } else if (m.type === 'permission_response') {
    await mcp.notification({ method: 'notifications/claude/channel/permission', params: { request_id: m.request_id, behavior: m.behavior } })
  }
})

// claude 关闭 MCP → stdin EOF → 退出，别留僵尸
function shutdown() { try { sock?.end() } catch {}; process.exit(0) }
process.stdin.on('end', shutdown); process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown)
