import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAndroidBackInterception } from '../../app/useAndroidBackInterception.js'
import { useTranslate } from '../../i18n/index.js'
import { useSettings } from '../../services/settings.js'
import { selectSession } from '../../services/chat/store.js'
import { requestScrollToMessage } from '../../services/chat/scrollTarget.js'
import { hitSnippet, searchMessages, type MessageHit } from '../../services/chat/searchHits.js'
import { formatDate } from '../../utils/format.js'
import { closeMobileSider } from '../sider/mobileSiderState.js'
import styles from './MessageSearchPage.module.css'

/**
 * 全页对话搜索。
 *
 * 与会话列表里的即时过滤不同，这里逐条消息列命中，点一条会跳到那条消息并高亮关键词。
 */

const Highlight = ({ text, term }: { text: string; term: string }) => {
  const needle = term.trim()
  if (!needle) {
    return <>{text}</>
  }
  const lower = text.toLocaleLowerCase()
  const target = needle.toLocaleLowerCase()
  const parts: React.ReactNode[] = []
  let cursor = 0
  let index = lower.indexOf(target)
  while (index >= 0) {
    if (index > cursor) {
      parts.push(text.slice(cursor, index))
    }
    parts.push(<b key={`${index}-${parts.length}`}>{text.slice(index, index + needle.length)}</b>)
    cursor = index + needle.length
    index = lower.indexOf(target, cursor)
  }
  if (cursor < text.length) {
    parts.push(text.slice(cursor))
  }
  return <>{parts}</>
}

export const MessageSearchPage = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const tr = (chinese: string, english: string) => (locale === 'zh-CN' ? chinese : english)
  const [term, setTerm] = useState('')
  const [hits, setHits] = useState<MessageHit[]>([])
  const [searching, setSearching] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)

  useAndroidBackInterception(open)

  useEffect(() => {
    if (!open) {
      setTerm('')
      setHits([])
      return
    }
    const focus = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(focus)
  }, [open])

  useEffect(() => {
    if (!open || !term.trim()) {
      setHits([])
      setSearching(false)
      return
    }
    let active = true
    setSearching(true)
    const timer = setTimeout(() => {
      void searchMessages(term, (batch) => {
        if (active) {
          setHits(batch)
        }
      })
        .then((all) => {
          if (active) {
            setHits(all)
            setSearching(false)
          }
        })
        .catch(() => {
          if (active) {
            setSearching(false)
          }
        })
    }, 200)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [open, term])

  if (!open) {
    return null
  }

  const pick = (hit: MessageHit) => {
    selectSession(hit.sessionId)
    requestScrollToMessage(hit.sessionId, hit.messageId, term)
    closeMobileSider()
    onClose()
  }

  return createPortal(
    <div ref={pageRef} className={styles.page} role="dialog" aria-modal="true" aria-label={tr('搜索对话', 'Search chats')}>
      <header className={styles.header}>
        <button type="button" className={styles.back} aria-label={tr('返回', 'Back')} onClick={onClose}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M12.5 4.5L7 10l5.5 5.5" />
          </svg>
        </button>
        <div className={styles.field}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <circle cx="7" cy="7" r="4.6" />
            <path d="M10.4 10.4L14 14" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            type="search"
            value={term}
            placeholder={tr('搜索对话内容', 'Search messages')}
            onChange={(event) => setTerm(event.target.value)}
          />
        </div>
      </header>

      <div className={styles.body}>
        {!term.trim() ? (
          <p className={styles.hint}>{tr('输入关键词，搜到的每一条消息都能点进去', 'Type a keyword to find every matching message')}</p>
        ) : hits.length === 0 ? (
          <p className={styles.hint}>{searching ? tr('正在搜索…', 'Searching…') : tr('没有找到相关内容', 'No matches')}</p>
        ) : (
          <>
            <p className={styles.count}>
              {tr('找到 ', 'Matches: ')}
              {hits.length}
              {tr(' 条消息', '')}
            </p>
            <ul className={styles.list}>
              {hits.map((hit) => (
                <li key={`${hit.sessionId}-${hit.messageId}-${hit.segment}`}>
                  <button type="button" className={styles.row} onClick={() => pick(hit)}>
                    <span className={styles.rowHead}>
                      <span className={styles.title}>{hit.title || t('untitledChat')}</span>
                      <span className={styles.date}>{formatDate(hit.updatedAt)}</span>
                    </span>
                    <span className={styles.snippet}>
                      <Highlight text={hitSnippet(hit.text, term)} term={term} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>,
    document.body
  )
}
