import { IconMenuOutline20, IconNewChatOutline20 } from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import { android } from '../../app/android.js'
import { newChat } from '../../services/chat/store.js'
import { setAutoRead, useSettings } from '../../services/settings.js'
import { stopReadAloud } from '../../services/speech/readAloud.js'
import { AndroidSound } from '../base/AndroidIcons.js'
import { IconButton } from '../base/IconButton.js'
import { showToast } from '../base/toastState.js'
import { openMobileSider } from '../sider/mobileSiderState.js'
import { openVoiceCall } from '../call/callState.js'
import styles from './MobileHeader.module.css'


const IconPhoneOutline = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
    <path
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      d="M4.2 6.6c0-.9.7-1.6 1.6-1.6h2.1c.6 0 1.1.4 1.3.9l.8 2c.2.5 0 1-.4 1.3l-1.1.8a11.4 11.4 0 0 0 5.5 5.5l.8-1.1c.3-.4.8-.6 1.3-.4l2 .8c.5.2.9.7.9 1.3v2.1c0 .9-.7 1.6-1.6 1.6A15.4 15.4 0 0 1 4.2 6.6Z"
    />
  </svg>
)

/** 移动端顶栏：左侧菜单打开侧边栏；会话页再显示标题与开启新对话 */
export const MobileHeader = ({ title }: { title?: string }) => {
  const t = useTranslate()
  const autoRead = useSettings((state) => state.autoRead)
  return (
    <div className={styles.header}>
      <IconButton
        size="xl"
        tone="primary"
        className={styles.menu}
        icon={<IconMenuOutline20 />}
        aria-label={t('expandSiderbarButton')}
        onClick={openMobileSider}
      />
      {title === undefined && !android ? null : (
        <>
          <div className={styles.title}>{title}</div>
          {android ? (
            <IconButton
              size="xl"
              tone="primary"
              className={styles.call}
              icon={<IconPhoneOutline />}
              aria-label={t('callVoiceTitle')}
              onClick={openVoiceCall}
            />
          ) : null}
          {android ? (
            <IconButton
              size="xl"
              tone="primary"
              className={styles.sound}
              icon={<AndroidSound muted={!autoRead} />}
              aria-label={t('androidAutoRead')}
              aria-pressed={autoRead}
              onClick={() => {
                setAutoRead(!autoRead)
                if (autoRead) {
                  stopReadAloud()
                }
                showToast({ key: autoRead ? 'androidAutoReadDisabled' : 'androidAutoReadEnabled' })
              }}
            />
          ) : null}
          <IconButton
            size="xl"
            tone="primary"
            className={styles.newChat}
            icon={<IconNewChatOutline20 />}
            aria-label={t('newChat')}
            onClick={newChat}
          />
        </>
      )}
    </div>
  )
}
