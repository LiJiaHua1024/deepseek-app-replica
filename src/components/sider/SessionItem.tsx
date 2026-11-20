import clsx from 'clsx'
import { memo, useRef, useState } from 'react'
import { android } from '../../app/android.js'
import { useTranslate } from '../../i18n/index.js'
import { IconEditOutline16, IconEllipsisOutline16, IconTrashOutline16 } from '../base/icons.js'
import { renameSession, selectSession } from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { IconButton } from '../base/IconButton.js'
import { Menu } from '../base/Menu.js'
import { useSettings } from '../../services/settings.js'
import { SessionDetailSheet } from './SessionDetailSheet.js'
import { closeMobileSider } from './mobileSiderState.js'
import styles from './SessionItem.module.css'

export const SessionItem = memo(function SessionItem({
  session,
  active,
  onDelete,
  selection,
}: {
  session: SessionSummary
  active: boolean
  onDelete: (session: SessionSummary) => void
  selection?: { checked: boolean; toggle: () => void }
}) {
  const t = useTranslate()
  const locale = useSettings((state) => state.locale)
  const tr = (chinese: string, english: string) => (locale === 'zh-CN' ? chinese : english)
  const [editing, setEditing] = useState(false)
  const [detail, setDetail] = useState(false)
  const actionsRef = useRef<HTMLDivElement>(null)
  const displayTitle = session.title || t('untitledChat')

  if (selection) {
    return (
      <button
        className={styles.select}
        type="button"
        role="checkbox"
        aria-checked={selection.checked}
        onClick={selection.toggle}
      >
        <span aria-hidden="true" />
        <div className={styles.title}>{displayTitle}</div>
      </button>
    )
  }

  if (editing) {
    const finish = (title: string) => {
      setEditing(false)
      if (title.trim() && title.trim() !== displayTitle) {
        renameSession(session.id, title.trim())
      }
    }
    return (
      <input
        className={styles.renameInput}
        defaultValue={displayTitle}
        autoFocus
        onFocus={(event) => event.target.select()}
        onBlur={(event) => finish(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            finish(event.currentTarget.value)
          } else if (event.key === 'Escape') {
            setEditing(false)
          }
        }}
      />
    )
  }

  return (
    <div
      className={clsx(styles.item, active && styles.active)}
      onContextMenu={(event) => {
        if (android) {
          event.preventDefault()
          actionsRef.current?.querySelector('button')?.click()
        }
      }}
      onClick={() => {
        selectSession(session.id)
        closeMobileSider()
      }}
    >
      <div className={styles.title}>{displayTitle}</div>
      <div ref={actionsRef} className={styles.action} onClick={(event) => event.stopPropagation()}>
        <Menu
          options={[
            {
              key: 'detail',
              label: tr('详情', 'Details'),
              icon: (
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
                  <circle cx="8" cy="8" r="6.2" />
                  <path d="M8 7.2v4" strokeLinecap="round" />
                  <circle cx="8" cy="4.9" r="0.85" fill="currentColor" stroke="none" />
                </svg>
              ),
              onSelect: () => setDetail(true),
            },
            {
              key: 'rename',
              label: t('sessionItemMenuRenameOption'),
              icon: <IconEditOutline16 />,
              onSelect: () => setEditing(true),
            },
            {
              key: 'delete',
              label: t('delete'),
              icon: <IconTrashOutline16 />,
              danger: true,
              onSelect: () => onDelete(session),
            },
          ]}
        >
          {({ toggle }) => (
            <IconButton icon={<IconEllipsisOutline16 />} aria-label={t('more')} onClick={toggle} />
          )}
        </Menu>
      </div>
      {detail ? <SessionDetailSheet session={session} onClose={() => setDetail(false)} /> : null}
    </div>
  )
})
