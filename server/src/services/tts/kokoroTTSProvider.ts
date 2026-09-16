/**
 * Kokoro TTS Provider
 *
 * Talks to a locally running Kokoro Gradio app (default http://127.0.0.1:7860).
 *
 * The Gradio docs advertise a Python client, but the underlying transport is a
 * plain 3-step HTTP flow that we can call directly from Node:
 *   1. POST /gradio_api/call/generate_speech  -> { event_id }
 *   2. GET  /gradio_api/call/generate_speech/<event_id> -> SSE stream, ends with
 *      an `event: complete` frame whose data is [FileData, phonemes]
 *   3. GET  the FileData.url to download the rendered WAV
 *
 * Unlike Gemini, Kokoro is a pure TTS model: it has no notion of a style prompt,
 * so `stylePrompt` is deliberately ignored (prepending it would make the model
 * read the instruction aloud). It does support a speech `speed` multiplier.
 */

import {
  TTSProvider,
  TTSInput,
  TTSResult,
  KOKORO_TTS_VOICES,
  KokoroTTSVoiceId
} from './types.js'

const MAX_RETRIES = 3
const RETRY_DELAY_MS = 1500
const REQUEST_TIMEOUT_MS = 120_000
const HEALTH_TIMEOUT_MS = 2_000

/** Kokoro renders 24kHz 16-bit mono WAV - same shape as Gemini's PCM output. */
const KOKORO_SAMPLE_RATE = 24000
const KOKORO_CHANNELS = 1
const KOKORO_BITS_PER_SAMPLE = 16

export interface KokoroTTSProviderConfig {
  baseUrl: string
  defaultVoice: string
  speed?: number
}

export class KokoroTTSProvider implements TTSProvider {
  readonly name = 'kokoro'
  readonly model = 'kokoro-82m'
  readonly defaultVoice: string

  private baseUrl: string
  private speed: number

  constructor(config: KokoroTTSProviderConfig) {
    // Trailing slashes break the /gradio_api/... concatenation below
    this.baseUrl = (config.baseUrl || 'http://127.0.0.1:7860').replace(/\/+$/, '')
    this.defaultVoice = resolveVoiceId(config.defaultVoice) || 'hf_alpha'
    this.speed = config.speed ?? 1.0
  }

  /**
   * Kokoro needs no API key - it is "configured" as long as we have a URL.
   * Actual reachability is a runtime concern (see isReachable/testConnection),
   * because the Gradio app is started independently of this server.
   */
  isConfigured(): boolean {
    return !!this.baseUrl
  }

  /** Cheap liveness probe used by the factory to decide on fallback. */
  async isReachable(): Promise<boolean> {
    try {
      const response = await fetchWithTimeout(this.baseUrl, {}, HEALTH_TIMEOUT_MS)
      return response.ok
    } catch {
      return false
    }
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      const response = await fetchWithTimeout(this.baseUrl, {}, HEALTH_TIMEOUT_MS)
      if (!response.ok) {
        return { success: false, error: `Kokoro server returned HTTP ${response.status}` }
      }
      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      return {
        success: false,
        error: `Cannot reach Kokoro at ${this.baseUrl}. Is the Gradio app running? (${message})`
      }
    }
  }

  getAvailableVoices(): string[] {
    return KOKORO_TTS_VOICES.map(v => v.id)
  }

  async generateSpeech(input: TTSInput): Promise<TTSResult> {
    // Only fall back to the default when no voice was requested at all - an
    // unrecognised voice must fail loudly rather than silently narrating in
    // the wrong voice.
    const voiceId = input.voice ? resolveVoiceId(input.voice) : this.defaultVoice

    if (!voiceId) {
      throw new Error(
        `Unknown Kokoro voice: "${input.voice}". Expected one of: ${KOKORO_TTS_VOICES.map(v => v.id).join(', ')}`
      )
    }

    const voiceKey = toKokoroVoiceKey(voiceId)

    if (!voiceKey) {
      throw new Error(`Unknown Kokoro voice: ${voiceId}`)
    }

    const speed = input.speed ?? this.speed

    // NOTE: input.stylePrompt is intentionally unused - Kokoro would speak it.
    return this.callWithRetry(async () => {
      const eventId = await this.submitJob(input.text, voiceKey, speed)
      const fileUrl = await this.awaitResult(eventId)
      const audioData = await this.downloadAudio(fileUrl)

      return {
        audioData,
        format: 'wav' as const,
        sampleRate: KOKORO_SAMPLE_RATE,
        channels: KOKORO_CHANNELS,
        bitsPerSample: KOKORO_BITS_PER_SAMPLE
      }
    })
  }

  /** Step 1: queue the job, get back an event id. */
  private async submitJob(text: string, voiceKey: string, speed: number): Promise<string> {
    const response = await fetchWithTimeout(
      `${this.baseUrl}/gradio_api/call/generate_speech`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: [text, voiceKey, speed] })
      },
      REQUEST_TIMEOUT_MS
    )

    if (!response.ok) {
      throw new Error(`Kokoro rejected the request (HTTP ${response.status})`)
    }

    const payload = await response.json() as { event_id?: string }
    if (!payload?.event_id) {
      throw new Error('Kokoro did not return an event_id')
    }

    return payload.event_id
  }

  /** Step 2: read the SSE stream until the `complete` frame carries the file. */
  private async awaitResult(eventId: string): Promise<string> {
    const response = await fetchWithTimeout(
      `${this.baseUrl}/gradio_api/call/generate_speech/${eventId}`,
      {},
      REQUEST_TIMEOUT_MS
    )

    if (!response.ok) {
      throw new Error(`Kokoro result stream failed (HTTP ${response.status})`)
    }

    const stream = await response.text()

    // Frames look like:  event: complete\ndata: [ {...FileData}, "phonemes" ]
    let lastError: string | null = null

    for (const frame of stream.split('\n\n')) {
      const eventLine = frame.match(/^event:\s*(.+)$/m)?.[1]?.trim()
      const dataLine = frame.match(/^data:\s*(.+)$/m)?.[1]

      if (!eventLine || !dataLine) continue

      if (eventLine === 'error') {
        lastError = dataLine
        continue
      }

      if (eventLine !== 'complete') continue

      let parsed: any
      try {
        parsed = JSON.parse(dataLine)
      } catch {
        throw new Error('Kokoro returned malformed result data')
      }

      const fileData = Array.isArray(parsed) ? parsed[0] : parsed
      const url = fileData?.url
      const filePath = fileData?.path

      if (url) return url
      // Older Gradio builds omit `url` and only give a server-side path
      if (filePath) return `${this.baseUrl}/gradio_api/file=${filePath}`

      throw new Error('Kokoro result contained no audio file')
    }

    throw new Error(
      lastError
        ? `Kokoro generation failed: ${lastError}`
        : 'Kokoro stream ended without a result'
    )
  }

  /** Step 3: fetch the rendered WAV bytes. */
  private async downloadAudio(fileUrl: string): Promise<Buffer> {
    const response = await fetchWithTimeout(fileUrl, {}, REQUEST_TIMEOUT_MS)

    if (!response.ok) {
      throw new Error(`Failed to download Kokoro audio (HTTP ${response.status})`)
    }

    const buffer = Buffer.from(await response.arrayBuffer())

    if (buffer.length === 0) {
      throw new Error('Kokoro returned an empty audio file')
    }

    return buffer
  }

  private async callWithRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: Error | null = null

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await fn()
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error))

        const message = lastError.message.toLowerCase()
        // A local model has no quotas; retry only on transport-level flakiness.
        const isRetryable =
          message.includes('timeout') ||
          message.includes('network') ||
          message.includes('fetch failed') ||
          message.includes('econnreset') ||
          message.includes('socket') ||
          message.includes('502') ||
          message.includes('503')

        if (!isRetryable || attempt === MAX_RETRIES - 1) {
          throw lastError
        }

        const delay = RETRY_DELAY_MS * Math.pow(2, attempt)
        console.log(`Kokoro TTS retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms: ${lastError.message}`)
        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }

    throw lastError || new Error('Max retries exceeded')
  }
}

/**
 * The Gradio dropdown only accepts the full emoji-decorated label
 * ("🇮🇳 🚺 Hindi Alpha (hf_alpha)"), but we persist the clean id ("hf_alpha")
 * so the database stays readable and voice-consistency checks keep working.
 */
export function toKokoroVoiceKey(voiceId: string): string | null {
  return KOKORO_TTS_VOICES.find(v => v.id === voiceId)?.key ?? null
}

/** Accepts either a clean id or a full emoji key and returns the clean id. */
export function resolveVoiceId(voice?: string): string | null {
  if (!voice) return null

  const byId = KOKORO_TTS_VOICES.find(v => v.id === voice)
  if (byId) return byId.id

  const byKey = KOKORO_TTS_VOICES.find(v => v.key === voice)
  if (byKey) return byKey.id

  // Tolerate a bare "(hf_alpha)" style suffix
  const extracted = voice.match(/\(([a-z]{2}_[a-z]+)\)\s*$/i)?.[1]
  if (extracted && KOKORO_TTS_VOICES.some(v => v.id === extracted)) {
    return extracted
  }

  return null
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

// Factory function
export function createKokoroTTSProvider(): KokoroTTSProvider | null {
  const baseUrl = process.env.KOKORO_URL || 'http://127.0.0.1:7860'
  const defaultVoice = process.env.KOKORO_DEFAULT_VOICE || 'hf_alpha'
  const speed = process.env.KOKORO_SPEED ? parseFloat(process.env.KOKORO_SPEED) : 1.0

  return new KokoroTTSProvider({ baseUrl, defaultVoice, speed })
}
