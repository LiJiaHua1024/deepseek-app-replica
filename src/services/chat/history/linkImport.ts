import { android } from '../../../app/android.js'

/**
 * 从链接下载导出包。
 *
 * WebView 里的 fetch 受 CORS 限制（导出链接不带跨域头），所以走原生下载，
 * 再按块取回拼成 File —— 后面的导入流程与"选择文件"完全一致。
 */

const CHUNK_BYTES = 512 * 1024

export type DownloadProgress = { loaded: number; total: number }

const decodeBase64 = (value: string) => {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

/** 挂好监听再启动下载，返回本次的令牌并等它 ready */
const beginDownload = (
  address: string,
  onProgress: (progress: DownloadProgress) => void
): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const device = android
    if (!device?.startHistoryDownload) {
      reject(new Error('当前环境不支持从链接导入'))
      return
    }
    let token = ''
    const listener = (event: Event) => {
      const detail = (
        event as CustomEvent<{ state: string; loaded: number; total: number; message: string }>
      ).detail
      if (detail.state === 'progress') {
        onProgress({ loaded: detail.loaded, total: detail.total })
        return
      }
      window.removeEventListener('android-download', listener)
      if (detail.state === 'ready') {
        resolve(token)
        return
      }
      reject(new Error(detail.message || '下载失败'))
    }
    window.addEventListener('android-download', listener)
    token = device.startHistoryDownload(address)
    if (!token) {
      window.removeEventListener('android-download', listener)
      reject(new Error('链接无效'))
    }
  })

/** 下载并返回可直接交给 importHistory 的 File */
export const downloadArchive = async (
  url: string,
  onProgress: (progress: DownloadProgress) => void
): Promise<File> => {
  const address = url.trim()
  if (!/^https?:\/\//i.test(address)) {
    throw new Error('链接需要以 http 或 https 开头')
  }
  const device = android
  if (!device?.readHistoryDownload || !device.historyDownloadSize) {
    throw new Error('当前环境不支持从链接导入')
  }
  const token = await beginDownload(address, onProgress)
  try {
    const size = device.historyDownloadSize(token)
    if (size <= 0) {
      throw new Error('下载内容为空')
    }
    const parts: Uint8Array[] = []
    for (let offset = 0; offset < size; offset += CHUNK_BYTES) {
      const chunk = device.readHistoryDownload(token, offset, CHUNK_BYTES)
      if (!chunk) {
        throw new Error('读取下载内容失败')
      }
      parts.push(decodeBase64(chunk))
    }
    const total = parts.reduce((sum, part) => sum + part.length, 0)
    const merged = new Uint8Array(total)
    let cursor = 0
    for (const part of parts) {
      merged.set(part, cursor)
      cursor += part.length
    }
    const raw = decodeURIComponent(address.split('?')[0].split('/').pop() || 'archive.zip')
    const name = raw.toLowerCase().endsWith('.zip') ? raw : `${raw}.zip`
    return new File([merged.buffer as ArrayBuffer], name, { type: 'application/zip' })
  } finally {
    device.releaseHistoryDownload?.(token)
  }
}
