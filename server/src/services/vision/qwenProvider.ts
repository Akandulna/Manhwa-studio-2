/**
 * Qwen3-VL via a local Ollama server (default http://127.0.0.1:11434).
 *
 * Uses /api/chat rather than /api/generate: the chat endpoint takes a real
 * system role and an `images` array of base64 strings per message, which is
 * what the VL models expect. Images are sent WITHOUT a data: URI prefix —
 * Ollama wants the raw base64 payload and silently fails to see the image if
 * the prefix is included.
 *
 * Like Kokoro, this needs no API key: it is "configured" whenever we have a
 * URL, and whether the server is actually up is a runtime question answered by
 * testConnection().
 *
 * Two traps this file exists to work around, both found the hard way:
 *
 *  1. STREAMING IS MANDATORY, even though we only want the final text. Node's
 *     undici enforces a ~5 minute headers timeout that AbortController and any
 *     `timeout` option cannot raise. A non-streamed /api/chat sends no headers
 *     until generation finishes, so a slow page dies with
 *     UND_ERR_HEADERS_TIMEOUT ("fetch failed") no matter how long we are
 *     willing to wait. Streaming sends the first chunk immediately, which
 *     starts the clock ticking on data rather than headers.
 *
 *  2. THE ANSWER ARRIVES IN THE WRONG FIELD. Qwen3-VL is a reasoning model, and
 *     this Ollama build (0.34) does not honour `think: false` for it. Worse,
 *     with `format: json` the real JSON answer is streamed into
 *     `message.thinking` while `message.content` stays EMPTY — the split is
 *     simply wrong. So both fields are collected and content falls back to
 *     thinking. Without that fallback every local detection returns nothing.
 *
 *     `format: json` is also what keeps it honest AND fast: with it the model
 *     answered in 65s; without it, it rambled for 708s and still emitted no
 *     content (done_reason "length" — it ran out of budget mid-thought).
 */

import { VisionProvider, VisionRequest, VisionResult } from './types.js'

const DEFAULT_URL = 'http://127.0.0.1:11434'
const DEFAULT_MODEL = 'qwen3-vl:4b'
/**
 * Generous because local inference genuinely is this slow: a 4B VL model on
 * Apple-silicon CPU/partial-GPU takes minutes per manhwa page, not seconds.
 * Overridable for faster hardware.
 */
const REQUEST_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS) || 1_800_000
const HEALTH_TIMEOUT_MS = 3_000

export interface QwenProviderConfig {
  baseUrl?: string
  model?: string
  keepAlive?: string
}

export class QwenVisionProvider implements VisionProvider {
  readonly name = 'qwen' as const
  readonly model: string
  readonly isLocal = true

  private baseUrl: string
  /** Holds the model in VRAM between pages; reloading per image dominates runtime. */
  private keepAlive: string

  constructor(config: QwenProviderConfig = {}) {
    this.baseUrl = (config.baseUrl || process.env.OLLAMA_URL || DEFAULT_URL).replace(/\/+$/, '')
    this.model = config.model || process.env.QWEN_VL_MODEL || DEFAULT_MODEL
    this.keepAlive = config.keepAlive || process.env.OLLAMA_KEEP_ALIVE || '10m'
  }

  isConfigured(): boolean {
    return !!this.baseUrl
  }

  async testConnection(): Promise<{ success: boolean; error?: string; models?: string[] }> {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS)
      const response = await fetch(`${this.baseUrl}/api/tags`, { signal: controller.signal })
      clearTimeout(timer)

      if (!response.ok) {
        return { success: false, error: `Ollama responded ${response.status}` }
      }

      const body = (await response.json()) as { models?: Array<{ name?: string }> }
      const models = (body.models ?? [])
        .map(m => m.name)
        .filter((n): n is string => typeof n === 'string')

      // A tag match is prefix-based: `qwen3-vl:4b` is listed as exactly that,
      // but a user may have pulled `qwen3-vl:4b-instruct-q4_K_M` and set it as
      // the model, so compare on the bare name too.
      const bare = this.model.split(':')[0]
      const installed = models.some(m => m === this.model || m.split(':')[0] === bare)

      if (!installed) {
        return {
          success: false,
          error: `Ollama is running but "${this.model}" is not pulled. Run: ollama pull ${this.model}`,
          models
        }
      }

      return { success: true, models }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error'
      const hint = message.includes('abort') || message.includes('fetch')
        ? `Could not reach Ollama at ${this.baseUrl}. Is it running? (ollama serve)`
        : message
      return { success: false, error: hint }
    }
  }

  async complete(request: VisionRequest): Promise<VisionResult> {
    const started = Date.now()

    const messages: Array<{ role: string; content: string; images?: string[] }> = []

    if (request.systemPrompt) {
      messages.push({ role: 'system', content: request.systemPrompt })
    }

    messages.push({
      role: 'user',
      content: request.userPrompt,
      // Raw base64, no data: prefix — see the module comment.
      images: request.images.map(img => img.data.toString('base64'))
    })

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          messages,
          // See the module comment: streamed purely to dodge undici's headers
          // timeout. The chunks are reassembled below into one reply.
          stream: true,
          keep_alive: this.keepAlive,
          // Reasoning would consume num_predict and can return empty content.
          think: false,
          ...(request.jsonMode ? { format: 'json' } : {}),
          options: {
            // Detection wants the same answer every run, so default to greedy.
            temperature: request.temperature ?? 0,
            ...(request.maxTokens ? { num_predict: request.maxTokens } : {})
          }
        })
      })

      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(`Ollama returned ${response.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`)
      }
      if (!response.body) {
        throw new Error('Ollama returned no response body')
      }

      // NDJSON: one JSON object per line, the last carrying the token counts.
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let text = ''
      let thinking = ''
      let promptEval = 0
      let evalCount = 0
      let ollamaError: string | null = null

      const consumeLine = (line: string) => {
        const trimmed = line.trim()
        if (!trimmed) return
        let chunk: any
        try {
          chunk = JSON.parse(trimmed)
        } catch {
          return // a partial line; the next read completes it
        }
        // Ollama reports mid-stream failures in-band rather than by status.
        if (typeof chunk?.error === 'string') ollamaError = chunk.error
        if (typeof chunk?.message?.content === 'string') text += chunk.message.content
        // See trap 2: with format:json the answer lands here instead.
        if (typeof chunk?.message?.thinking === 'string') thinking += chunk.message.thinking
        if (typeof chunk?.prompt_eval_count === 'number') promptEval = chunk.prompt_eval_count
        if (typeof chunk?.eval_count === 'number') evalCount = chunk.eval_count
      }

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) consumeLine(line)
      }
      consumeLine(buffer)

      if (ollamaError) {
        throw new Error(`Ollama: ${ollamaError}`)
      }

      // The reasoning channel carries the real answer on this build, so it is a
      // fallback rather than debug output.
      if (!text.trim() && thinking.trim()) {
        text = thinking
      }

      if (!text.trim()) {
        throw new Error(
          'Qwen returned an empty response — no content and no reasoning text. ' +
          'The model may have run out of budget; raise maxTokens, shrink the page, ' +
          'or switch provider in Settings.'
        )
      }

      const body = { prompt_eval_count: promptEval, eval_count: evalCount }

      return {
        text,
        model: this.model,
        provider: this.name,
        tokensUsed: (body.prompt_eval_count ?? 0) + (body.eval_count ?? 0),
        durationMs: Date.now() - started
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(
          `Qwen timed out after ${Math.round(REQUEST_TIMEOUT_MS / 60000)} minutes. ` +
          'Local inference on a tall page is slow; raise OLLAMA_TIMEOUT_MS, use a ' +
          'smaller/quantized model, or switch provider in Settings.'
        )
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }
}

export function createQwenVisionProvider(): QwenVisionProvider {
  // Always constructible: no key to miss, and reachability is checked per call.
  return new QwenVisionProvider()
}
