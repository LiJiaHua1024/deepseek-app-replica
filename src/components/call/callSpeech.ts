import { TTS_SAMPLE_RATE, synthesize } from '../../services/api/speech.js'
import { useSettings } from '../../services/settings.js'

/**
 * 通话模式的朗读播放。
 *
 * 与服务端 TTS 的分块流配合：边下边排程，abort 立刻停声。
 * 单独放一份是为了不改动现有的 readAloud 模块（那条链路给"朗读这段"按钮用，
 * 有自己的单例状态；通话页需要可被随时打断、并且等它播完再继续听）。
 */

const START_DELAY = 0.1

const toFloat32 = (bytes: Uint8Array) => {
  const samples = new Float32Array(bytes.length >> 1)
  const view = new DataView(bytes.buffer, bytes.byteOffset, samples.length * 2)
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = view.getInt16(i * 2, true) / 0x8000
  }
  return samples
}

/** 朗读一段文本，播完才 resolve；signal 中断时尽快返回 */
export const speakText = async (
  text: string,
  signal: AbortSignal,
  onError: (error: unknown) => void
): Promise<void> => {
  if (!text.trim()) {
    return
  }
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort)
  const context = new AudioContext({ sampleRate: TTS_SAMPLE_RATE })
  let nextTime = 0
  let lastSource: AudioBufferSourceNode | null = null
  let rest = new Uint8Array(0)
  try {
    const { apiKey, ttsVoice } = useSettings.getState()
    const stream = await synthesize(apiKey ?? '', text, ttsVoice, controller.signal)
    const reader = stream.getReader()
    controller.signal.addEventListener('abort', () => void reader.cancel().catch(() => undefined))
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      const bytes = new Uint8Array(rest.length + value.length)
      bytes.set(rest)
      bytes.set(value, rest.length)
      const samples = toFloat32(bytes)
      rest = bytes.slice(samples.length * 2)
      if (samples.length === 0) {
        continue
      }
      const buffer = context.createBuffer(1, samples.length, TTS_SAMPLE_RATE)
      buffer.copyToChannel(samples, 0)
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(context.destination)
      // 网络慢于播放时从当前时间续上，不补播过去的时间
      nextTime = Math.max(nextTime, context.currentTime + (lastSource ? 0 : START_DELAY))
      source.start(nextTime)
      nextTime += buffer.duration
      lastSource = source
    }
    if (lastSource) {
      await new Promise<void>((resolve) => {
        const tail = lastSource as AudioBufferSourceNode
        tail.onended = () => resolve()
        controller.signal.addEventListener('abort', () => resolve())
      })
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      onError(error)
    }
  } finally {
    signal.removeEventListener('abort', abort)
    if (context.state !== 'closed') {
      void context.close().catch(() => undefined)
    }
  }
}
