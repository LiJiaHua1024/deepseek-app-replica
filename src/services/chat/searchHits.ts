import { loadSession, loadSessionSummaries } from './db.js'
import { useChatStore } from './store.js'
import type { Session } from './types.js'

/**
 * 逐条消息的搜索命中。
 *
 * 对话搜索面板只需要"哪条消息里出现了这个词"，所以这里比会话级搜索多走一步：
 * 定位到具体消息，供点击后跳转并使用。
 */

export type MessageHit = {
  sessionId: string
  messageId: string
  /** 会话标题 */
  title: string
  /** 命中的那条消息的正文 */
  text: string
  role: 'user' | 'assistant'
  /** 同一条会话内的第几段命中，用于列表 key */
  segment: number
  updatedAt: number
}

type Entry = { id: string; role: 'user' | 'assistant'; text: string }

type BlockLike = { type: string; text?: string }

const assistantText = (blocks: BlockLike[] | undefined) =>
  (blocks ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')

const sessionText = (session: Session): Entry[] =>
  session.messages.map((message) => ({
    id: message.id,
    role: message.role,
    text:
      message.role === 'user'
        ? message.content
        : assistantText((message as { blocks?: BlockLike[] }).blocks),
  }))

/** 命中的那一行（前后各留一点上下文），供列表展示 */
export const hitSnippet = (text: string, term: string, radius = 28) => {
  const index = text.toLocaleLowerCase().indexOf(term.toLocaleLowerCase())
  if (index < 0) {
    return text.slice(0, radius * 2)
  }
  const from = Math.max(0, index - radius)
  const to = Math.min(text.length, index + term.length + radius)
  return `${from > 0 ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`
}

/**
 * 扫描全部会话，产出逐条消息的命中。
 * 每扫完一个会话回调一次，界面可以边搜边显示。
 */
export const searchMessages = async (
  term: string,
  onBatch?: (hits: MessageHit[]) => void
): Promise<MessageHit[]> => {
  const needle = term.trim().toLocaleLowerCase()
  if (!needle) {
    return []
  }
  const summaries = await loadSessionSummaries()
  const hits: MessageHit[] = []
  for (const summary of summaries) {
    const cached = useChatStore.getState().sessionCache[summary.id]
    const session = cached ?? (await loadSession(summary.id).catch(() => undefined))
    if (!session) {
      continue
    }
    const matched = sessionText(session)
      .map((entry, segment) => ({ entry, segment }))
      .filter(({ entry }) => entry.text.toLocaleLowerCase().includes(needle))
    if (matched.length === 0) {
      continue
    }
    for (const { entry, segment } of matched) {
      hits.push({
        sessionId: session.id,
        messageId: entry.id,
        title: summary.title,
        text: entry.text,
        role: entry.role,
        segment,
        updatedAt: summary.updatedAt,
      })
    }
    onBatch?.([...hits])
  }
  return hits
}
