/**
 * Vision provider types — multimodal "image in, text out" calls.
 *
 * Deliberately separate from services/ai/types.ts. That AIProvider interface is
 * shaped around the narration pipeline (scripts, summaries, beats, outros); the
 * jobs here are single-shot "look at this one image and answer in JSON". Making
 * the narration interface carry crop detection would force every provider to
 * implement five methods it has no use for, which is exactly what kept the AI
 * factory gemini-only.
 *
 * A provider is a transport: it knows how to send image+prompt to one backend
 * and return the raw text. Prompt content and JSON parsing live in the caller,
 * so all providers answer to the same contract and can be swapped per request.
 */

export interface VisionImage {
  data: Buffer
  mimeType: string
}

export interface VisionRequest {
  /** Steering text sent as the system role where the backend supports one. */
  systemPrompt?: string
  /** The instruction the model acts on, sent alongside the image. */
  userPrompt: string
  images: VisionImage[]
  /**
   * Ask the backend to emit strict JSON. Honoured natively by Ollama
   * (`format: json`) and the OpenAI-compatible APIs; a provider that cannot
   * enforce it still returns text the caller parses defensively.
   */
  jsonMode?: boolean
  maxTokens?: number
  temperature?: number
}

export interface VisionResult {
  text: string
  model: string
  provider: string
  tokensUsed?: number
  /** Wall-clock duration of the call, surfaced in the UI for local runs. */
  durationMs?: number
}

export interface VisionProvider {
  readonly name: VisionProviderName
  readonly model: string
  /** True when a local backend needs no API key, so the UI can skip key prompts. */
  readonly isLocal: boolean

  complete(request: VisionRequest): Promise<VisionResult>

  /** Configured = has everything needed to attempt a call (key, or a URL for local). */
  isConfigured(): boolean

  /** Actually reachable/authorized right now. Local backends can be down. */
  testConnection(): Promise<{ success: boolean; error?: string; models?: string[] }>
}

export type VisionProviderName = 'qwen' | 'gemini' | 'openai' | 'anthropic'

export const VISION_PROVIDER_LABELS: Record<VisionProviderName, string> = {
  qwen: 'Qwen3-VL (local)',
  gemini: 'Gemini',
  openai: 'OpenAI',
  anthropic: 'Claude'
}
