import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import { useAndroidBackInterception } from '../../app/useAndroidBackInterception.js'
import { useTranslate } from '../../i18n/index.js'
import { loadSession } from '../../services/chat/db.js'
import { useSettings } from '../../services/settings.js'
import { useChatStore } from '../../services/chat/store.js'
import type { Session, SessionSummary } from '../../services/chat/types.js'
import { copyText } from '../../utils/clipboard.js'
import { showToast } from '../base/toastState.js'
import styles from './SessionDetailSheet.module.css'

/**
 * 会话详情面板。
 *
 * 显示来源、创建时间（导入的会话取导出包里的原始时间）、最后更新、消息数、
 * 模型与会话 ID（可一键复制）。按官方口径不显示置顶状态。
 */

/** 上游 utils/format 只有日期；详情要显示到分钟，这里自带一个，避免改公共工具 */
const formatDateTime = (value: number) => {
  const date = new Date(value)
  const pad = (input: number) => String(input).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const Row = ({
  icon,
  label,
  value,
  action,
}: {
  icon: React.ReactNode
  label: string
  value: React.ReactNode
  action?: React.ReactNode
}) => (
  <div className={styles.row}>
    <span className={styles.rowIcon} aria-hidden="true">
      {icon}
    </span>
    <div className={styles.rowBody}>
      <span className={styles.rowLabel}>{label}</span>
      <span className={styles.rowValue}>{value}</span>
    </div>
    {action}
  </div>
)

const IconClock = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
    <circle cx="10" cy="10" r="7.2" />
    <path d="M10 6.2V10l2.6 1.7" strokeLinecap="round" />
  </svg>
)

const IconChat = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M3.2 9a6 6 0 016-6h1.6a6 6 0 010 12H8l-4.4 2.2L4.4 14A6 6 0 013.2 9z" strokeLinejoin="round" />
  </svg>
)

const IconTag = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M3.5 8.6V4.2h4.4l8.2 8.2-4.4 4.4z" strokeLinejoin="round" />
    <circle cx="6.6" cy="6.6" r="1.1" fill="currentColor" stroke="none" />
  </svg>
)

const IconCopy = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5">
    <rect x="7" y="3.4" width="9.6" height="11.2" rx="2" />
    <path d="M12.4 16.6H5.4a2 2 0 01-2-2V7.4" strokeLinecap="round" />
  </svg>
)

export const SessionDetailSheet = ({
  session,
  onClose,
}: {
  session: SessionSummary
  onClose: () => void
}) => {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const tr = (chinese: string, english: string) => (locale === 'zh-CN' ? chinese : english)
  const cached = useChatStore((state) => state.sessionCache[session.id])
  const [loaded, setLoaded] = useState<Session | undefined>(cached)
  const [shown, setShown] = useState(false)
  const sheet = useRef<HTMLElement>(null)

  useAndroidBackInterception(true)

  // 挂载后下一帧再切换，保证 transition 从收起状态开始播
  useEffect(() => {
    const frame = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  // 会话可能还没进缓存：直接读库补齐
  useEffect(() => {
    if (cached) {
      setLoaded(cached)
      return
    }
    let active = true
    void loadSession(session.id).then((next) => {
      if (active) {
        setLoaded(next)
      }
    })
    return () => {
      active = false
    }
  }, [cached, session.id])

  // 导入的会话保留导出包里的原始 ID（DeepSeek 端是 session- 前缀）
  const imported = session.id.startsWith('session-')
  const messageCount = loaded?.messages.length
  const model = (() => {
    const messages = loaded?.messages ?? []
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const candidate = messages[index]
      if (candidate.role === 'assistant' && candidate.model) {
        return candidate.model
      }
    }
    return null
  })()

  return createPortal(
    <div
      className={clsx(styles.overlay, shown && styles.overlayShown)}
      onClick={onClose}
      role="presentation"
    >
      <section
        ref={sheet}
        className={clsx(styles.sheet, shown && styles.sheetShown)}
        role="dialog"
        aria-modal="true"
        aria-label={tr('会话详情', 'Chat details')}
        onClick={(event) => event.stopPropagation()}
      >
        <header className={styles.header}>
          <h2 className={styles.title}>{tr('会话详情', 'Chat details')}</h2>
        </header>

        <div className={styles.rows}>
          <Row
            icon={<IconTag />}
            label={tr('来源', 'Source')}
            value={imported ? tr('导入的对话', 'Imported chat') : tr('本机新建', 'Created on device')}
          />
          <Row
            icon={<IconClock />}
            label={tr('创建时间', 'Created')}
            value={formatDateTime(session.createdAt)}
          />
          <Row
            icon={<IconClock />}
            label={tr('最后更新', 'Last updated')}
            value={formatDateTime(session.updatedAt)}
          />
          <Row
            icon={<IconChat />}
            label={tr('消息数', 'Messages')}
            value={messageCount === undefined ? '—' : messageCount}
          />
          {model ? (
            <Row icon={<IconTag />} label={tr('模型', 'Model')} value={model} />
          ) : null}
          <Row
            icon={<IconCopy />}
            label={tr('会话 ID', 'Chat ID')}
            value={<span className={styles.mono}>{session.id}</span>}
            action={
              <button
                type="button"
                className={styles.copy}
                aria-label={t('copy')}
                onClick={() => {
                  void copyText(session.id)
                  showToast(tr('会话 ID 已复制', 'Chat ID copied'))
                }}
              >
                <IconCopy />
              </button>
            }
          />
        </div>
      </section>
    </div>,
    document.body
  )
}
