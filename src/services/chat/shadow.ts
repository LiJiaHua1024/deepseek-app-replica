import type { AndroidBridge } from '../../app/android.js'
import { readBlobChunks } from '../../utils/blob.js'
import type { StoredFile } from './db.js'
import type { Session } from './types.js'

/**
 * 聊天数据的原生文件影子镜像（Android 端 filesDir/chat-shadow，见 ShadowStore.java）。
 *
 * WebView 的 IndexedDB 可能被 Chromium QuotaManager、LevelDB 损坏或 ROM 清理静默清空整库。
 * 每次主存储写成功后，这里把会话 JSON 和附件原件增量镜像到原生私有目录；
 * 冷启动或运行期检测到 IndexedDB 变成空库时，再从镜像全量恢复回 IndexedDB。
 *
 * 镜像失败只记日志，绝不影响主流程；恢复期间置位 restoring，避免把读回的数据再写一遍镜像。
 */

/** 桥方法必须挂在注入对象上调用（WebView 禁止在非注入对象上调用），因此直接返回注入对象本身。 */
type ShadowBridge = Required<
  Pick<
    AndroidBridge,
    | 'shadowBegin'
    | 'shadowAppend'
    | 'shadowFinish'
    | 'shadowList'
    | 'shadowReadChunk'
    | 'shadowDelete'
    | 'shadowClearAll'
  >
>

/** 懒读取桥接对象：WebView 中 window 即 globalThis；node 测试环境下不存在时返回 null。 */
const shadowDevice = (): ShadowBridge | null => {
  const device = (globalThis as { DeepSeekAndroid?: AndroidBridge }).DeepSeekAndroid
  if (
    device?.shadowBegin &&
    device.shadowAppend &&
    device.shadowFinish &&
    device.shadowList &&
    device.shadowReadChunk &&
    device.shadowDelete &&
    device.shadowClearAll
  ) {
    return device as ShadowBridge
  }
  return null
}

export const shadowAvailable = (): boolean => shadowDevice() !== null

const WRITE_CHUNK = 32 * 1024
const READ_CHUNK = 256 * 1024

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += WRITE_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + WRITE_CHUNK))
  }
  return btoa(binary)
}

const base64ToBytes = (base64: string): Uint8Array => {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/** 桥接同一时刻只允许一个写入流，所有镜像写操作串行排队。 */
let queue: Promise<unknown> = Promise.resolve()
let restoring = false

/** 从镜像恢复回主存储期间置 true，跳过镜像写（避免把读回的数据再写一遍）。 */
export const setShadowRestoring = (value: boolean) => {
  restoring = value
}

const enqueue = (task: (device: ShadowBridge) => Promise<void>) => {
  if (restoring) {
    return
  }
  const device = shadowDevice()
  if (!device) {
    return
  }
  queue = queue.then(() => task(device)).catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error('[shadow] mirror write failed', error)
  })
}

const writeStream = async (
  device: ShadowBridge,
  path: string,
  chunks: AsyncGenerator<Uint8Array>
) => {
  if (!device.shadowBegin(path)) {
    throw new Error(`shadow begin failed: ${path}`)
  }
  try {
    for await (const chunk of chunks) {
      if (!device.shadowAppend(bytesToBase64(chunk))) {
        throw new Error(`shadow append failed: ${path}`)
      }
    }
    if (!device.shadowFinish(true)) {
      throw new Error(`shadow finish failed: ${path}`)
    }
  } catch (error) {
    device.shadowFinish(false)
    throw error
  }
}

async function* textChunks(text: string): AsyncGenerator<Uint8Array> {
  const bytes = new TextEncoder().encode(text)
  for (let offset = 0; offset < bytes.length; offset += READ_CHUNK) {
    yield bytes.subarray(offset, offset + READ_CHUNK)
  }
}

const readFile = async (device: ShadowBridge, path: string): Promise<Uint8Array> => {
  const parts: Uint8Array[] = []
  let offset = 0
  for (;;) {
    const base64 = device.shadowReadChunk(path, offset, READ_CHUNK)
    if (!base64) {
      break
    }
    const chunk = base64ToBytes(base64)
    parts.push(chunk)
    offset += chunk.length
  }
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let position = 0
  for (const part of parts) {
    result.set(part, position)
    position += part.length
  }
  return result
}

/** 镜像一条会话（详情 JSON）及其新增附件原件；失败只记日志。 */
export const mirrorSession = (session: Session, files: StoredFile[] = []) => {
  enqueue(async (device) => {
    await writeStream(device, `sessions/${session.id}.json`, textChunks(JSON.stringify(session)))
    for (const file of files) {
      await writeStream(device, `files/${file.id}.bin`, readBlobChunks(file.blob))
    }
  })
}

/** 镜像附件原件（上传新附件、导入落盘后调用）。 */
export const mirrorFiles = (files: StoredFile[]) => {
  enqueue(async (device) => {
    for (const file of files) {
      await writeStream(device, `files/${file.id}.bin`, readBlobChunks(file.blob))
    }
  })
}

/** 删除会话后清理镜像；fileIds 是已无任何会话引用的附件原件。 */
export const mirrorDeleteSession = (id: string, fileIds: string[]) => {
  enqueue((device) => {
    device.shadowDelete(`sessions/${id}.json`)
    for (const fileId of fileIds) {
      device.shadowDelete(`files/${fileId}.bin`)
    }
    return Promise.resolve()
  })
}

/**
 * 清空整个镜像（删除所有历史、覆盖导入提交成功后调用）。
 * 必须可靠完成：清不掉会导致冷启动时把已删除的历史恢复回来，因此同步等待结果返回。
 */
export const mirrorClearAll = (): Promise<boolean> => {
  const device = shadowDevice()
  if (!device) {
    return Promise.resolve(false)
  }
  const done = queue.then(() => {
    if (restoring) {
      return false
    }
    return device.shadowClearAll()
  })
  queue = done.catch(() => {})
  return done
}

/** 列出镜像中的全部会话 id。 */
export const listShadowSessions = async (): Promise<string[]> => {
  const device = shadowDevice()
  if (!device) {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(device.shadowList('sessions'))
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

/** 读取镜像中的一条会话详情；损坏或不存在时返回 undefined。 */
export const readShadowSession = async (id: string): Promise<Session | undefined> => {
  const device = shadowDevice()
  if (!device) {
    return undefined
  }
  try {
    const bytes = await readFile(device, `sessions/${id}.json`)
    if (bytes.length === 0) {
      return undefined
    }
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (
      typeof parsed !== 'object' || parsed === null || !Array.isArray((parsed as Session).messages)
    ) {
      return undefined
    }
    return parsed as Session
  } catch {
    return undefined
  }
}

/** 读取镜像中的附件原件；不存在时返回 undefined。 */
export const readShadowFile = async (id: string): Promise<Blob | undefined> => {
  const device = shadowDevice()
  if (!device) {
    return undefined
  }
  try {
    const bytes = await readFile(device, `files/${id}.bin`)
    return bytes.length === 0 ? undefined : new Blob([bytes.buffer as ArrayBuffer])
  } catch {
    return undefined
  }
}
