import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import {
  buildMessageVersions,
  getVisibleMessages,
  type MessageVersions,
} from '../../services/chat/branches.js'
import { selectMessageVersion } from '../../services/chat/store.js'
import type { Session } from '../../services/chat/types.js'
import { closeSearchPanel } from '../search/searchPanelState.js'
import { AssistantMessage } from './AssistantMessage.js'
import { ScrollToBottomContext } from './scrollContext.js'
import { UserMessage } from './UserMessage.js'
import type { Message } from '../../services/chat/types.js'

/**
 * 会话共用可重试的附件上传失败入口，覆盖当前提问与历史消息中的附件。
 * 点击后按失败的回答重新补传附件并请求。
 */
const getUploadRetryId = (messages: Message[], streaming: boolean) => {
  const last = messages.at(-1)
  return !streaming &&
    last?.role === 'assistant' &&
    last.status === 'error' &&
    last.error?.kind === 'upload' &&
    last.error.retryable
    ? last.id
    : null
}
import {
  clearScrollTarget,
  useScrollTarget,
} from '../../services/chat/scrollTarget.js'
import styles from './MessageList.module.css'

/** 距底部小于该值时视为在底部，流式内容增长时跟随 */
const STICKY_THRESHOLD = 40
const EMPTY_VERSIONS: MessageVersions = { ids: [], index: -1 }
const INITIAL_MESSAGES = 4
const OLDER_MESSAGES = 8
const OLDER_THRESHOLD = 320

export const MessageList = ({
  session,
  streaming,
  footer,
}: {
  session: Session
  streaming: boolean
  footer: React.ReactNode
}) => {
  const isMobile = useIsMobile()
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const stickyRef = useRef(true)
  const scrollTopRef = useRef(0)
  const restoreScrollRef = useRef<{ messageId: string; top: number } | null>(null)
  const messages = useMemo(() => getVisibleMessages(session), [session])
  const scrollTarget = useScrollTarget((state) => state.target)
  const latestStart = Math.max(0, messages.length - INITIAL_MESSAGES)
  const [messageWindow, setMessageWindow] = useState({ sessionId: session.id, start: latestStart })
  const start =
    messageWindow.sessionId === session.id
      ? Math.min(messageWindow.start, latestStart)
      : latestStart
  if (messageWindow.sessionId !== session.id || messageWindow.start !== start) {
    setMessageWindow({ sessionId: session.id, start })
  }
  const prependAnchor = useRef<{ element: Element; top: number } | null>(null)
  const [previousVersions, setPreviousVersions] = useState(() =>
    buildMessageVersions(session, new Map())
  )
  const versions = useMemo(
    () => buildMessageVersions(session, previousVersions),
    [session, previousVersions]
  )
  if (versions !== previousVersions) {
    setPreviousVersions(versions)
  }
  const lastMessageId = messages.at(-1)?.id
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (el && stickyRef.current) {
      el.scrollTop = el.scrollHeight
      scrollTopRef.current = el.scrollTop
    }
  }, [])
  const stopFollowing = useCallback(() => {
    stickyRef.current = false
  }, [])
  // 内容、键盘和输入框高度变化时，继续遵循当前跟随状态。
  useLayoutEffect(() => {
    const content = contentRef.current
    const scroll = scrollRef.current
    if (!content || !scroll) {
      return
    }
    const observer = new ResizeObserver(scrollToBottom)
    observer.observe(content)
    observer.observe(scroll)
    return () => observer.disconnect()
  }, [isMobile, scrollToBottom])

  // 首屏从最近几条消息开始。向上浏览时逐批补齐，保持原来的阅读位置。
  useLayoutEffect(() => {
    const scroll = scrollRef.current
    const content = contentRef.current
    if (!scroll || !content) {
      return
    }
    const anchor = prependAnchor.current
    prependAnchor.current = null
    if (anchor?.element.isConnected && !stickyRef.current) {
      scroll.scrollTop += anchor.element.getBoundingClientRect().top - anchor.top
      scrollTopRef.current = scroll.scrollTop
    }
    if (!start) {
      return
    }

    let frame = 0
    const loadOlder = () => {
      if (frame) {
        return
      }
      frame = requestAnimationFrame(() => {
        frame = 0
        const fits = scroll.scrollHeight - scroll.clientHeight <= STICKY_THRESHOLD
        if (!fits && (stickyRef.current || scroll.scrollTop > OLDER_THRESHOLD)) {
          return
        }
        const element = content.firstElementChild
        if (element) {
          prependAnchor.current = { element, top: element.getBoundingClientRect().top }
        }
        setMessageWindow({ sessionId: session.id, start: Math.max(0, start - OLDER_MESSAGES) })
      })
    }
    const observer = new ResizeObserver(loadOlder)
    observer.observe(scroll)
    observer.observe(content)
    scroll.addEventListener('scroll', loadOlder, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      scroll.removeEventListener('scroll', loadOlder)
    }
  }, [isMobile, session.id, start])

  // 搜索命中后跳转：窗口没覆盖到目标就先补齐，再把它滚到视口上方三分之一处并标出关键词。
  useLayoutEffect(() => {
    if (!scrollTarget || scrollTarget.sessionId !== session.id) {
      return
    }
    const index = messages.findIndex((message) => message.id === scrollTarget.messageId)
    if (index < 0) {
      clearScrollTarget()
      return
    }
    // 目标还在窗口之外：先把窗口扩到包含它，渲染后本效应会再跑一次
    if (index < start) {
      stickyRef.current = false
      setMessageWindow({ sessionId: session.id, start: Math.max(0, index - 2) })
      return
    }
    const scroller = scrollRef.current
    if (!scroller) {
      return
    }
    const messageId = scrollTarget.messageId
    const term = scrollTarget.term
    stickyRef.current = false
    clearScrollTarget()

    const markTerm = (node: HTMLElement) => {
      const highlightApi = window as unknown as {
        Highlight?: new (range: Range) => unknown
        CSS?: { highlights?: Map<string, unknown> }
      }
      if (!term || !highlightApi.Highlight || !highlightApi.CSS?.highlights) {
        return
      }
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT)
      let text = ''
      const nodes: { node: Text; start: number }[] = []
      let current = walker.nextNode()
      while (current) {
        const textNode = current as Text
        nodes.push({ node: textNode, start: text.length })
        text += textNode.data
        current = walker.nextNode()
      }
      const found = text.toLocaleLowerCase().indexOf(term.toLocaleLowerCase())
      if (found < 0) {
        return
      }
      const locate = (offset: number) => {
        for (let i = nodes.length - 1; i >= 0; i -= 1) {
          if (offset >= nodes[i].start) {
            return { node: nodes[i].node, offset: offset - nodes[i].start }
          }
        }
        return { node: nodes[0].node, offset: 0 }
      }
      try {
        const from = locate(found)
        const to = locate(found + term.length)
        const range = document.createRange()
        range.setStart(from.node, Math.min(from.offset, from.node.data.length))
        range.setEnd(to.node, Math.min(to.offset, to.node.data.length))
        highlightApi.CSS.highlights.set('dsh-search-hit', new highlightApi.Highlight(range))
        window.setTimeout(() => highlightApi.CSS?.highlights?.delete('dsh-search-hit'), 2600)
      } catch {
        // 定位失败不影响滚动
      }
    }

    const align = () => {
      const node = scroller.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(messageId)}"]`
      )
      if (!node || !scroller.isConnected) {
        return
      }
      if (!node.classList.contains(styles.flash)) {
        node.classList.add(styles.flash)
        window.setTimeout(() => node.classList.remove(styles.flash), 1600)
        markTerm(node)
      }
      const box = scroller.getBoundingClientRect()
      const rect = node.getBoundingClientRect()
      const top =
        scroller.scrollTop + (rect.top - box.top) - box.height * 0.32
      scroller.scrollTo({
        top: Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, top)),
        behavior: 'smooth',
      })
    }

    ;[0, 80, 240, 520].forEach((delay) => window.setTimeout(align, delay))
  }, [scrollTarget, session.id, messages, start])

  // 切换版本后将选择器留在原位置，避免回答长短变化导致操作区跳出视口。
  useLayoutEffect(() => {
    const anchor = restoreScrollRef.current
    const scroll = scrollRef.current
    if (anchor && scroll) {
      const switcher = scroll.querySelector<HTMLElement>(
        `[data-message-version="${CSS.escape(anchor.messageId)}"]`
      )
      if (switcher) {
        scroll.scrollTop += switcher.getBoundingClientRect().top - anchor.top
      }
      restoreScrollRef.current = null
      return
    }
    stickyRef.current = true
    scrollToBottom()
  }, [session.id, lastMessageId, scrollToBottom])

  useEffect(closeSearchPanel, [session.id, lastMessageId])

  const selectVersion = useCallback(
    (messageId: string, anchorTop: number) => {
      if (streaming) {
        return
      }
      restoreScrollRef.current = { messageId, top: anchorTop }
      stickyRef.current = false
      closeSearchPanel()
      selectMessageVersion(session.id, messageId)
    },
    [session.id, streaming]
  )

  // 跨移动端断点时切换滚动层，并保持输入框及当前阅读位置。
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    if (stickyRef.current) {
      scrollToBottom()
    } else {
      el.scrollTop = scrollTopRef.current
    }
    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_THRESHOLD
      // 仅在用户向上滚动时停止跟随底部，布局或内容增高时保持跟随状态。
      if (nearBottom) {
        stickyRef.current = true
      } else if (el.scrollTop < scrollTopRef.current) {
        stickyRef.current = false
      }
      scrollTopRef.current = el.scrollTop
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [isMobile, scrollToBottom])

  const lastIndex = messages.length - 1
  const uploadRetryId = getUploadRetryId(messages, streaming)
  return (
    <ScrollToBottomContext.Provider value={stopFollowing}>
      <div ref={isMobile ? undefined : scrollRef} className={styles.container}>
        <div ref={isMobile ? scrollRef : undefined} className={styles.scroll}>
          <div ref={contentRef} className={styles.column}>
            {messages.slice(start).map((message, offset) => {
              const index = start + offset
              return message.role === 'user' ? (
                <UserMessage
                  key={message.id}
                  sessionId={session.id}
                  message={message}
                  retryUploadId={uploadRetryId}
                  isFirst={index === 0}
                  isLast={index === lastIndex || index === lastIndex - 1}
                  busy={streaming}
                  versions={versions.get(message.id) ?? EMPTY_VERSIONS}
                  onSelectVersion={selectVersion}
                />
              ) : (
                <AssistantMessage
                  key={message.id}
                  sessionId={session.id}
                  message={message}
                  isLast={index === lastIndex}
                  streaming={streaming && index === lastIndex}
                  busy={streaming}
                  versions={versions.get(message.id) ?? EMPTY_VERSIONS}
                  onSelectVersion={selectVersion}
                />
              )
            })}
          </div>
        </div>
        {footer}
      </div>
    </ScrollToBottomContext.Provider>
  )
}
