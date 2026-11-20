import {
  DEFAULT_CHAT_CONFIG,
  DEFAULT_CHAT_MODEL,
  type ChatConfig,
} from '../api/chatConfig.js'
import { streamChatMessage } from '../api/client.js'
import { getReplyText } from './reply.js'
import type { MemoryLedgerBlock, Session } from './types.js'

/**
 * 事实账本（append-only）。
 *
 * 与现有的「滚动摘要 + 检查点」并存、互不干扰：摘要会随裁剪重写，
 * 账本只往后追加，写下的块永不修改，所以请求前缀稳定、缓存命中不受影响。
 *
 * 每满 MEMORY_BLOCK_ROUNDS 轮追加一块：事实 / 决定 / 偏好 / 待办。
 */

export const MEMORY_BLOCK_ROUNDS = 20
const BLOCK_MAX_CHARS = 620
const EXCERPT_CHARS = 1_200
const BLOCK_TIMEOUT_MS = 30_000

const LEDGER_PROMPT = `你在为一段很长的对话整理"事实账本"，供之后回顾使用。

只输出四行，不要标题、不要解释、不要代码块：
事实：<这段对话里确定下来的、可复述的客观信息>
决定：<已经做出的决定或结论>
偏好：<用户表达过的偏好、禁忌、风格要求>
待办：<尚未完成或需要继续跟进的事>

要求：每行不超过 40 字；没有内容写「无」；只写对话里确实出现过的内容；用陈述句。`

/** 拼进 system：只按顺序排列，块内容不再变化 */
export const withMemoryLedger = (system: string, blocks?: MemoryLedgerBlock[]) => {
  if (!blocks?.length) {
    return system
  }
  const body = blocks
    .map((block) => `#${block.index}（第 ${block.fromRound}-${block.toRound} 轮）\n${block.text}`)
    .join('\n\n')
  return `${system}\n\n<memory_log>\n${body}\n</memory_log>`
}

/** 一轮 = 一条用户消息（含它的回答） */
const roundCount = (session: Session) =>
  session.messages.reduce((sum, message) => sum + (message.role === 'user' ? 1 : 0), 0)

/** 还有没被账本覆盖的轮次时，返回下一块要覆盖的范围 */
export const nextMemoryRange = (session: Session) => {
  const covered = session.memoryLedger?.at(-1)?.toRound ?? 0
  const total = roundCount(session)
  return total - covered >= MEMORY_BLOCK_ROUNDS
    ? { fromRound: covered, toRound: covered + MEMORY_BLOCK_ROUNDS }
    : null
}

const collectExcerpt = (session: Session, fromRound: number, toRound: number) => {
  const lines: string[] = []
  let round = -1
  for (const message of session.messages) {
    if (message.role === 'user') {
      round += 1
    }
    if (round < fromRound || round >= toRound) {
      continue
    }
    if (message.role === 'user') {
      if (message.content) {
        lines.push(`用户：${message.content.slice(0, EXCERPT_CHARS)}`)
      }
    } else {
      const text = getReplyText(message).slice(0, EXCERPT_CHARS)
      if (text) {
        lines.push(`助手：${text}`)
      }
    }
  }
  return lines.join('\n\n')
}

/** 生成一块账本；失败返回 null（下次再补，不会写入半成品） */
export const createMemoryBlock = async (
  session: Session,
  range: { fromRound: number; toRound: number },
  apiKey: string,
  config: ChatConfig = DEFAULT_CHAT_CONFIG
): Promise<MemoryLedgerBlock | null> => {
  const excerpt = collectExcerpt(session, range.fromRound, range.toRound)
  if (!excerpt) {
    return null
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), BLOCK_TIMEOUT_MS)
  try {
    let text = ''
    const events = streamChatMessage(
      config,
      apiKey,
      {
        model: config.model || DEFAULT_CHAT_MODEL,
        max_tokens: 400,
        system: LEDGER_PROMPT,
        messages: [{ role: 'user', content: [{ type: 'text', text: excerpt }] }],
        thinking: { type: 'disabled' },
      },
      controller.signal
    )
    for await (const event of events) {
      if (event.type === 'content_block_start' && event.content_block.type === 'text') {
        text += event.content_block.text
      } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        text += event.delta.text
      }
    }
    const body = text.replaceAll('\r\n', '\n').trim()
    if (!body) {
      return null
    }
    const blocks = session.memoryLedger ?? []
    return {
      index: blocks.length + 1,
      fromRound: range.fromRound,
      toRound: range.toRound,
      text: body.slice(0, BLOCK_MAX_CHARS),
      createdAt: Date.now(),
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
