import type { AndroidBridge } from '../../app/android.js'
import { readBlobChunks } from '../../utils/blob.js'
import { mergeSessions } from './history/mergeSessions.js'
import { deleteLegacyHistory, openLegacyHistory } from './indexedDb.js'
import {
  reportStorageError,
  storedSummary,
  type HistoryStaging,
  type StagingWriter,
  type StoredFile,
} from './storageTypes.js'
import {
  toSessionSummary,
  type AssistantMessage,
  type FileAttachment,
  type Session,
  type SessionSummary,
  type UserMessage,
} from './types.js'

const device = (globalThis as { DeepSeekAndroid?: AndroidBridge }).DeepSeekAndroid
export const available = Boolean(device?.chatStorage || device?.chatStorageAsync)

type PendingRequest = {
  method: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}
type ChatStorageReplyEvent = {
  id: string
  reply: { value?: unknown; error?: string }
}

let requestSeq = 0
const pendingRequests = new Map<string, PendingRequest>()

if (device?.chatStorageAsync && typeof globalThis.addEventListener === 'function') {
  globalThis.addEventListener('android-chat-storage', (event: Event) => {
    const detail = (event as CustomEvent<ChatStorageReplyEvent>).detail
    if (!detail?.id) {
      return
    }
    const pending = pendingRequests.get(detail.id)
    if (!pending) {
      return
    }
    pendingRequests.delete(detail.id)
    if (detail.reply?.error) {
      pending.reject(new Error(`${pending.method}: ${detail.reply.error}`))
    } else {
      pending.resolve(detail.reply?.value)
    }
  })
}

const dispatchAsync = <Result>(method: string, call: (id: string) => void): Promise<Result> =>
  new Promise<Result>((resolve, reject) => {
    const id = String(++requestSeq)
    pendingRequests.set(id, {
      method,
      resolve: resolve as (value: unknown) => void,
      reject,
    })
    try {
      call(id)
    } catch (error) {
      pendingRequests.delete(id)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })

const request = async <Result = unknown>(method: string, payload: object = {}): Promise<Result> => {
  const json = JSON.stringify(payload)
  const asyncCall = device?.chatStorageAsync
  if (asyncCall) {
    return dispatchAsync<Result>(method, (id) => asyncCall.call(device, id, method, json))
  }
  const reply = device?.chatStorage?.(method, json)
  if (!reply) {
    throw new Error('Android chat storage is unavailable')
  }
  const result = JSON.parse(reply) as { value: Result; error?: string }
  if (result.error) {
    throw new Error(`${method}: ${result.error}`)
  }
  return result.value
}

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const CHUNK_SIZE = 32 * 1024

const decode = (base64: string) => {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

type UploadedFile = { id: string; object: string; type: string }

const write = async ({
  token,
  sessions = [],
  files = [],
  add = false,
  overrideFiles = false,
}: {
  token?: string
  sessions?: Session[]
  files?: StoredFile[]
  add?: boolean
  overrideFiles?: boolean
} = {}) => {
  const uploads: UploadedFile[] = []
  try {
    for (const { id, blob } of files) {
      const object = await request<string>('upload', { token })
      uploads.push({ id, object, type: blob.type })
      for await (const chunk of readBlobChunks(blob)) {
        for (let offset = 0; offset < chunk.length; offset += CHUNK_SIZE) {
          const data = btoa(String.fromCharCode(...chunk.subarray(offset, offset + CHUNK_SIZE)))
          await request('append', { object, data })
        }
      }
    }
    const writeSessionAsync = device?.chatStorageWriteSessionAsync
    if (sessions.length === 1 && writeSessionAsync) {
      const session = sessions[0]
      const metaJson = JSON.stringify({
        token,
        files: uploads,
        summary: storedSummary(session),
        add,
        overrideFiles,
      })
      const sessionJson = JSON.stringify(session)
      await dispatchAsync<null>('write', (id) =>
        writeSessionAsync.call(device, id, metaJson, sessionJson)
      )
    } else {
      await request('write', {
        token,
        files: uploads,
        sessions: sessions.map((session) => ({
          ...storedSummary(session),
          data: JSON.stringify(session),
        })),
        add,
        overrideFiles,
      })
    }
  } catch (error) {
    for (const { object } of uploads) {
      try {
        await request('abandon', { object })
      } catch (cleanupError) {
        reportStorageError('abandon attachment upload')(cleanupError)
      }
    }
    throw error
  }
}

const readSession = async (id: string, token?: string): Promise<Session | undefined> => {
  const data = await request<string | null>('read', { id, token })
  return data === null ? undefined : (JSON.parse(data) as Session)
}

const readFileTypes = async (ids: Iterable<string>, token: string, includeStaged = false) => {
  const keys = [...new Set(ids)]
  return keys.length
    ? new Map(await request<[string, string][]>('fileTypes', { ids: keys, token, includeStaged }))
    : new Map<string, string>()
}

const pages = async function* <Row>(
  method: 'summaries' | 'ids',
  key: (row: Row) => string,
  token?: string
) {
  let after: string | undefined
  for (;;) {
    const rows = await request<Row[]>(method, { token, after })
    if (!rows.length) {
      return
    }
    yield rows
    after = key(rows[rows.length - 1])
    await pause()
  }
}

const collectSummaries = async () => {
  const summaries: SessionSummary[] = []
  for await (const page of pages('summaries', (summary: SessionSummary) => summary.id)) {
    summaries.push(...page)
  }
  return summaries
}

const mirrorIds = (dir: 'sessions' | 'files'): string[] => {
  const json = device?.shadowList?.(dir)
  if (json == null) {
    throw new Error('Unable to list the legacy Android mirror')
  }
  return JSON.parse(json) as string[]
}

const readMirror = (path: string): Uint8Array<ArrayBuffer>[] => {
  const parts: Uint8Array<ArrayBuffer>[] = []
  let offset = 0
  for (;;) {
    const base64 = device?.shadowReadChunk?.(path, offset)
    if (base64 == null) {
      throw new Error('Unable to read the legacy Android mirror')
    }
    if (!base64) {
      return parts
    }
    const bytes = decode(base64)
    parts.push(bytes)
    offset += bytes.length
  }
}

const sanitizeLegacySession = (id: string, value: unknown): Session | undefined => {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const raw = value as Record<string, unknown>
  if (!Array.isArray(raw.messages)) {
    return undefined
  }
  const rawCreated =
    typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : undefined
  const rawUpdated =
    typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : undefined
  const createdAt = rawCreated ?? rawUpdated ?? 0
  const updatedAt = rawUpdated ?? rawCreated ?? 0
  const messages = raw.messages.flatMap((item): Session['messages'] => {
    if (!item || typeof item !== 'object') {
      return []
    }
    const msg = item as Record<string, unknown>
    if (msg.role === 'user') {
      const files = Array.isArray(msg.files)
        ? msg.files.filter(
            (file): file is FileAttachment =>
              Boolean(file) &&
              typeof file === 'object' &&
              typeof (file as { id?: unknown }).id === 'string'
          )
        : []
      return [{ ...(msg as UserMessage), files }]
    }
    if (msg.role === 'assistant') {
      return [msg as AssistantMessage]
    }
    return []
  })
  return {
    ...(raw as Session),
    id: typeof raw.id === 'string' && raw.id ? raw.id : id,
    title: typeof raw.title === 'string' ? raw.title : '',
    createdAt,
    updatedAt,
    messages,
  }
}

const readMirrorSession = (id: string): Session | undefined => {
  const bytes = readMirror(`sessions/${id}.json`)
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const text = bytes.map((part) => decoder.decode(part, { stream: true })).join('')
    const parsed = JSON.parse(text + decoder.decode()) as { id?: unknown } | null
    if (parsed?.id === id) {
      return sanitizeLegacySession(id, parsed)
    }
  } catch {
    // Keep the unreadable source for recovery.
  }
  return undefined
}

export type MigrationNotice = { recovered: number; missing: number; unverified: number }

const migrate = async () => {
  const legacy = await openLegacyHistory()
  const notice: MigrationNotice = { recovered: 0, missing: 0, unverified: 0 }
  let token: string | undefined
  try {
    const sessionIds = new Set(await legacy?.sessionIds())
    const indexedFiles = new Set(await legacy?.fileIds())
    const indexedIds = new Set([...sessionIds, ...((await legacy?.summaryIds()) ?? [])])
    const mirrorSessions = new Set(mirrorIds('sessions'))
    const mirrorFiles = new Set(mirrorIds('files'))
    const useMirrorList = indexedIds.size === 0
    const ids = useMirrorList ? mirrorSessions : indexedIds
    // An intact legacy index is authoritative for presence. A mirror-only record might
    // be an intentional deletion whose asynchronous mirror write was interrupted.
    if (!useMirrorList) {
      notice.unverified = [...mirrorSessions].filter((id) => !indexedIds.has(id)).length
    }

    token = await request<string>('begin', { migration: true })
    const referenced = new Map<string, string>()
    let failedFiles = 0
    let batch: { session: Session; recovered: boolean }[] = []
    let batchBytes = 0

    const recordReferences = (session: Session) => {
      for (const message of session.messages) {
        if (message.role === 'user') {
          for (const file of message.files ?? []) {
            if (!referenced.get(file.id)) {
              referenced.set(file.id, file.mimeType ?? '')
            }
          }
        }
      }
    }

    const flushSessions = async () => {
      if (!batch.length) {
        return
      }
      const current = batch
      batch = []
      batchBytes = 0
      try {
        await write({
          token,
          sessions: current.map((item) => item.session),
          add: true,
        })
        for (const item of current) {
          recordReferences(item.session)
          if (item.recovered) {
            notice.recovered += 1
          }
        }
      } catch {
        for (const item of current) {
          try {
            await write({ token, sessions: [item.session], add: true })
            recordReferences(item.session)
            if (item.recovered) {
              notice.recovered += 1
            }
          } catch (error) {
            reportStorageError('migrate legacy session')(error)
            notice.missing += 1
          }
        }
      }
      await pause()
    }

    for (const id of ids) {
      let indexed: Session | undefined
      if (sessionIds.has(id)) {
        try {
          indexed = sanitizeLegacySession(id, await legacy?.session(id))
        } catch (error) {
          reportStorageError('read legacy session')(error)
        }
      }
      let recovered = false
      let session = indexed
      if (!session && mirrorSessions.has(id)) {
        session = readMirrorSession(id)
        recovered = Boolean(session)
      }
      if (!session) {
        notice.missing += 1
        continue
      }
      batch.push({ session, recovered })
      batchBytes += JSON.stringify(session).length
      if (batch.length >= 32 || batchBytes >= 2 * 1024 * 1024) {
        await flushSessions()
      }
    }
    await flushSessions()

    for (const id of indexedFiles) {
      try {
        let file: StoredFile | undefined
        try {
          const original = await legacy?.file(id)
          if (original?.blob && typeof original.blob.size === 'number') {
            file = original
          }
        } catch (error) {
          reportStorageError('read legacy attachment')(error)
        }
        if (!file && mirrorFiles.has(id)) {
          const blob = new Blob(readMirror(`files/${id}.bin`), { type: referenced.get(id) ?? '' })
          file = { id, blob }
        }
        if (!file) {
          failedFiles += 1
          continue
        }
        await write({ token, files: [file] })
      } catch (error) {
        reportStorageError('migrate legacy attachment')(error)
        failedFiles += 1
      }
      await pause()
    }
    for (const id of mirrorFiles) {
      if (!indexedFiles.has(id) && (useMirrorList || referenced.has(id))) {
        try {
          const blob = new Blob(readMirror(`files/${id}.bin`), { type: referenced.get(id) ?? '' })
          await write({ token, files: [{ id, blob }] })
        } catch (error) {
          reportStorageError('migrate mirror attachment')(error)
          failedFiles += 1
        }
        await pause()
      }
    }

    // This SQLite transaction publishes both stores and the one-time migration marker.
    const retainLegacy = notice.missing > 0 || notice.unverified > 0 || failedFiles > 0
    await request('replace', { token, retainLegacy })
  } catch (error) {
    if (token) {
      try {
        await request('discard', { token })
      } catch (discardError) {
        reportStorageError('discard unfinished migration')(discardError)
      }
    }
    throw error
  } finally {
    legacy?.close()
  }
  if (notice.recovered || notice.missing || notice.unverified) {
    globalThis.dispatchEvent(new CustomEvent('chat-storage-migrated', { detail: notice }))
  }
}

const retireLegacy = async () => {
  try {
    if (await request<boolean>('canRetire')) {
      await pause()
      await deleteLegacyHistory()
      if (!device?.shadowClearAll?.()) {
        throw new Error('Unable to remove the legacy Android mirror')
      }
      await request('retired')
    }
  } catch (error) {
    reportStorageError('retire migrated history')(error)
  }
}

let initialized = false
const initialize = async () => {
  if (initialized) {
    return
  }
  if (await request<boolean>('needsMigration')) {
    await migrate()
  }
  initialized = true
  await retireLegacy()
}

// File uploads yield while reading blobs. Keep write ordering across those yields,
// including when a rename or delete follows a save still uploading an attachment.
let queue: Promise<unknown> = Promise.resolve()
const run = <Result>(operation: () => Result | Promise<Result>): Promise<Result> => {
  const result = queue.then(async () => {
    await initialize()
    return operation()
  })
  queue = result.catch(() => {})
  return result
}

export const loadSessionSummaries = () => run(collectSummaries)
export const loadSession = (id: string) => run(() => readSession(id))
export const saveSession = (session: Session, files?: StoredFile[]) =>
  run(() => write({ sessions: [session], files }))
export const renameSession = (id: string, title: string) =>
  run(async () => {
    const session = await readSession(id)
    if (session) {
      await write({ sessions: [{ ...session, title }] })
    }
  })
export const deleteSession = (id: string) =>
  run(async () => {
    await request('remove', { id })
  })

export const scanSessions = (
  onSession: (session: Session) => boolean,
  skip?: ReadonlySet<string>
) =>
  run(async () => {
    for await (const ids of pages('ids', (id: string) => id)) {
      for (const id of ids) {
        if (!skip?.has(id)) {
          const session = await readSession(id)
          if (session && !onSession(session)) {
            return
          }
        }
      }
    }
  })

export const loadFile = async (id: string): Promise<Blob | undefined> => {
  const file = await run(async () => {
    const metadata = await request<{ object: string; type: string } | null>('file', { id })
    if (!metadata) {
      return undefined
    }
    const response = await fetch(`/chat-attachment/${metadata.object}`, { cache: 'no-store' })
    if (!response.ok) {
      throw new Error('An Android chat attachment is unreadable')
    }
    return { type: metadata.type, response }
  })
  if (file) {
    const blob = await file.response.blob()
    return blob.slice(0, blob.size, file.type)
  }
  return undefined
}

const applyFileTypes = (session: Session, types: ReadonlyMap<string, string>) => {
  let changed = false
  for (const message of session.messages) {
    if (message.role === 'user') {
      for (const file of message.files) {
        const type = types.get(file.id) ?? ''
        if (file.mimeType !== type) {
          file.mimeType = type
          changed = true
        }
      }
    }
  }
  return changed
}

const readStaged = async (id: string, token: string) => {
  const session = await readSession(id, token)
  if (!session) {
    throw new Error(`Staged session disappeared: ${id}`)
  }
  return session
}

export const stagingWriter = (token: string): StagingWriter => {
  const summaries: SessionSummary[] = []
  return {
    summaries,
    getActiveFileTypes: (ids) => run(() => readFileTypes(ids, token)),
    async addSessions(sessions) {
      await run(() => write({ token, sessions, add: true }))
      for (const session of sessions) {
        summaries.push(toSessionSummary(session))
      }
    },
    addFiles: (files) => run(() => write({ token, files })),
    updateFileTypes: (ids, types) =>
      run(async () => {
        for (const id of ids) {
          const session = await readStaged(id, token)
          if (applyFileTypes(session, types)) {
            await write({ token, sessions: [session] })
          }
        }
      }),
  }
}

export const beginStaging = async (): Promise<HistoryStaging> => {
  const token = await run(() => request<string>('begin'))
  return {
    importId: token,
    commit: () =>
      run(async () => {
        await request('replace', { token })
        await retireLegacy()
      }),
    discard: () =>
      run(async () => {
        await request('discard', { token })
      }),
    commitMerge: ({ localOverrides } = {}) =>
      run(async () => {
        const revision = await request<string>('revision', { token })
        const summaries = new Map((await collectSummaries()).map((item) => [item.id, item]))
        const stagedIds: string[] = []
        for await (const ids of pages('ids', (id: string) => id, token)) {
          stagedIds.push(...ids)
        }
        const overrideFiles = stagedIds.flatMap((id) => localOverrides?.get(id)?.files ?? [])
        for (let i = 0; i < overrideFiles.length; i += 8) {
          await write({ token, files: overrideFiles.slice(i, i + 8), overrideFiles: true })
        }
        let added = 0
        let merged = 0
        let unchanged = 0
        const updatedIds: string[] = []
        for (let i = 0; i < stagedIds.length; i += 64) {
          for (const id of stagedIds.slice(i, i + 64)) {
            const incoming = await readStaged(id, token)
            const override = localOverrides?.get(id)
            const local =
              override?.session ?? (summaries.has(id) ? await readSession(id) : undefined)
            const fileIds = [
              ...storedSummary(incoming).fileIds,
              ...(local ? storedSummary(local).fileIds : []),
            ]
            const fileTypes = await readFileTypes(fileIds, token, true)
            if (!local) {
              let changed = false
              for (const message of incoming.messages) {
                if (message.role === 'user') {
                  for (const file of message.files) {
                    const type = fileTypes.get(file.id)
                    if (!file.mimeType && type) {
                      file.mimeType = type
                      changed = true
                    }
                  }
                }
              }
              if (changed) {
                await write({ token, sessions: [incoming] })
              }
              summaries.set(id, toSessionSummary(incoming))
              added += 1
              continue
            }
            const result = mergeSessions(local, incoming, { fileTypes })
            if (result.changed || override) {
              await write({ token, sessions: [result.session] })
              summaries.set(id, toSessionSummary(result.session))
              updatedIds.push(id)
            } else {
              await request('remove', { token, id })
            }
            if (result.changed) {
              merged += 1
            } else {
              unchanged += 1
            }
          }
          await pause()
        }
        await request('merge', { token, revision })
        return { summaries: [...summaries.values()], added, merged, unchanged, updatedIds }
      }),
  }
}
