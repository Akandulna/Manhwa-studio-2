/**
 * Cloud vision providers: Gemini, OpenAI and Claude behind one interface.
 *
 * All three are plain REST calls rather than SDK clients. The narration code
 * already pulls in @google/genai, but adding two more SDKs for what is a single
 * POST each would be a heavier dependency than the code it saves — and keeping
 * them uniform here means the crop route never branches on provider.
 *
 * Each one is responsible only for shaping image+prompt into its own wire
 * format and returning raw text. JSON parsing is the caller's job.
 */

import { VisionProvider, VisionRequest, VisionResult } from './types.js'

const REQUEST_TIMEOUT_MS = 180_000
const MAX_RETRIES = 3
const RETRY_BASE_DELAY_MS = 2_000

/** Transient server-side conditions worth another attempt. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])

async function postJsonOnce(
  url: string,
  body: unknown,
  headers: Record<string, string>
): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      const error: any = new Error(
        `${response.status} ${response.statusText}${detail ? `: ${detail.slice(0, 300)}` : ''}`
      )
      error.status = response.status
      throw error
    }
    return await response.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Retries the overload responses these APIs return under load (503 especially —
 * Gemini serves them routinely). Without this a whole-chapter run aborts one
 * page in on a condition that clears in seconds.
 */
async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>
): Promise<any> {
  let lastError: any

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await postJsonOnce(url, body, headers)
    } catch (error: any) {
      lastError = error
      const retryable = RETRYABLE_STATUS.has(error?.status) || error?.name === 'AbortError'
      if (!retryable || attempt === MAX_RETRIES - 1) throw error

      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt)
      console.log(`[vision] ${error?.status ?? 'timeout'} — retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }

  throw lastError
}

// ============ Gemini ============

export class GeminiVisionProvider implements VisionProvider {
  readonly name = 'gemini' as const
  readonly model: string
  readonly isLocal = false
  private apiKey: string

  constructor(apiKey: string, model?: string) {
    this.apiKey = apiKey
    this.model = model || process.env.GEMINI_VISION_MODEL || 'gemini-3.5-flash'
  }

  isConfigured(): boolean {
    return !!this.apiKey
  }

  async testConnection() {
    if (!this.isConfigured()) return { success: false, error: 'GEMINI_API_KEY not set' }
    try {
      await postJson(
        `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`,
        { contents: [{ role: 'user', parts: [{ text: 'Say OK.' }] }] },
        {}
      )
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  }

  async complete(request: VisionRequest): Promise<VisionResult> {
    if (!this.isConfigured()) throw new Error('GEMINI_API_KEY not configured')
    const started = Date.now()

    const parts: any[] = request.images.map(img => ({
      inlineData: { mimeType: img.mimeType, data: img.data.toString('base64') }
    }))
    parts.push({ text: request.userPrompt })

    const body: any = {
      contents: [{ role: 'user', parts }],
      generationConfig: {
        ...(request.maxTokens ? { maxOutputTokens: request.maxTokens } : {}),
        ...(request.jsonMode ? { responseMimeType: 'application/json' } : {}),
        // Gemini 3.x bills reasoning against maxOutputTokens, so a page with
        // many panels can spend the whole budget thinking and return JSON cut
        // off mid-object. Detection needs no reasoning, so it is turned off.
        thinkingConfig: { thinkingBudget: 0 }
      }
    }
    if (request.systemPrompt) {
      body.systemInstruction = { parts: [{ text: request.systemPrompt }] }
    }

    const result = await postJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`,
      body,
      {}
    )

    const text = (result?.candidates?.[0]?.content?.parts ?? [])
      .map((p: any) => p?.text ?? '')
      .join('')

    const finishReason = result?.candidates?.[0]?.finishReason

    if (!text.trim()) {
      throw new Error(
        finishReason === 'SAFETY'
          ? 'Gemini blocked this image with a safety filter.'
          : `Gemini returned no text${finishReason ? ` (finishReason: ${finishReason})` : ''}`
      )
    }

    // MAX_TOKENS means the reply is cut mid-JSON. Said plainly here, because
    // downstream it only looks like malformed output.
    if (finishReason === 'MAX_TOKENS') {
      throw new Error(
        'Gemini hit the output token limit and the JSON is truncated. ' +
        'Raise maxTokens, or ask for fewer crops per page.'
      )
    }

    return {
      text,
      model: this.model,
      provider: this.name,
      tokensUsed: result?.usageMetadata?.totalTokenCount,
      durationMs: Date.now() - started
    }
  }
}

// ============ OpenAI ============

export class OpenAIVisionProvider implements VisionProvider {
  readonly name = 'openai' as const
  readonly model: string
  readonly isLocal = false
  private apiKey: string
  private baseUrl: string

  constructor(apiKey: string, model?: string, baseUrl?: string) {
    this.apiKey = apiKey
    this.model = model || process.env.OPENAI_VISION_MODEL || 'gpt-4o'
    this.baseUrl = (baseUrl || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '')
  }

  isConfigured(): boolean {
    return !!this.apiKey
  }

  async testConnection() {
    if (!this.isConfigured()) return { success: false, error: 'OPENAI_API_KEY not set' }
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10_000)
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: controller.signal
      })
      clearTimeout(timer)
      if (!response.ok) return { success: false, error: `OpenAI responded ${response.status}` }
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  }

  async complete(request: VisionRequest): Promise<VisionResult> {
    if (!this.isConfigured()) throw new Error('OPENAI_API_KEY not configured')
    const started = Date.now()

    const content: any[] = request.images.map(img => ({
      type: 'image_url',
      image_url: { url: `data:${img.mimeType};base64,${img.data.toString('base64')}` }
    }))
    content.push({ type: 'text', text: request.userPrompt })

    const messages: any[] = []
    if (request.systemPrompt) messages.push({ role: 'system', content: request.systemPrompt })
    messages.push({ role: 'user', content })

    const result = await postJson(
      `${this.baseUrl}/chat/completions`,
      {
        model: this.model,
        messages,
        ...(request.maxTokens ? { max_completion_tokens: request.maxTokens } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.jsonMode ? { response_format: { type: 'json_object' } } : {})
      },
      { Authorization: `Bearer ${this.apiKey}` }
    )

    const text = result?.choices?.[0]?.message?.content ?? ''
    if (!text.trim()) throw new Error('OpenAI returned no text')

    return {
      text,
      model: this.model,
      provider: this.name,
      tokensUsed: result?.usage?.total_tokens,
      durationMs: Date.now() - started
    }
  }
}

// ============ Anthropic / Claude ============

export class AnthropicVisionProvider implements VisionProvider {
  readonly name = 'anthropic' as const
  readonly model: string
  readonly isLocal = false
  private apiKey: string

  constructor(apiKey: string, model?: string) {
    this.apiKey = apiKey
    this.model = model || process.env.ANTHROPIC_VISION_MODEL || 'claude-sonnet-5'
  }

  isConfigured(): boolean {
    return !!this.apiKey
  }

  async testConnection() {
    if (!this.isConfigured()) return { success: false, error: 'ANTHROPIC_API_KEY not set' }
    try {
      await postJson(
        'https://api.anthropic.com/v1/messages',
        { model: this.model, max_tokens: 16, messages: [{ role: 'user', content: 'Say OK.' }] },
        { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' }
      )
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' }
    }
  }

  async complete(request: VisionRequest): Promise<VisionResult> {
    if (!this.isConfigured()) throw new Error('ANTHROPIC_API_KEY not configured')
    const started = Date.now()

    const content: any[] = request.images.map(img => ({
      type: 'image',
      source: {
        type: 'base64',
        media_type: img.mimeType,
        data: img.data.toString('base64')
      }
    }))
    content.push({ type: 'text', text: request.userPrompt })

    const result = await postJson(
      'https://api.anthropic.com/v1/messages',
      {
        model: this.model,
        // Anthropic requires max_tokens; the default covers a page of crops.
        max_tokens: request.maxTokens ?? 8192,
        ...(request.systemPrompt ? { system: request.systemPrompt } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        messages: [{ role: 'user', content }]
      },
      { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' }
    )

    const text = (result?.content ?? [])
      .filter((block: any) => block?.type === 'text')
      .map((block: any) => block.text)
      .join('')

    if (!text.trim()) throw new Error('Claude returned no text')

    return {
      text,
      model: this.model,
      provider: this.name,
      tokensUsed:
        (result?.usage?.input_tokens ?? 0) + (result?.usage?.output_tokens ?? 0),
      durationMs: Date.now() - started
    }
  }
}
