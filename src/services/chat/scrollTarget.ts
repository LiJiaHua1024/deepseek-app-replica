import { create } from 'zustand'

/**
 * 搜索命中后的跳转目标。
 *
 * 由搜索页写入，消息列表消费：先把窗口补到包含这条消息，再滚动定位并高亮关键词。
 */
export type ScrollTarget = { sessionId: string; messageId: string; term: string }

type ScrollTargetState = { target: ScrollTarget | null }

export const useScrollTarget = create<ScrollTargetState>(() => ({ target: null }))

export const requestScrollToMessage = (sessionId: string, messageId: string, term: string) =>
  useScrollTarget.setState({ target: { sessionId, messageId, term } })

export const clearScrollTarget = () => useScrollTarget.setState({ target: null })
