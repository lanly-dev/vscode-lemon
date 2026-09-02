import * as http from 'http'
import { Logger } from './logger'
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  HealthResponse,
  LemonadeModel,
  PullStreamEvent
} from './interfaces'

/**
 * HTTP client for the Lemonade Server API.
 * Communicates with the local Lemonade Server using OpenAI-compatible endpoints.
 */
export class LemonadeClient {
  private baseUrl: string

  constructor(url: string) {
    // Trim and check for empty string
    if (url.trim().length === 0) throw new Error('URL cannot be empty or whitespace only.')
    this.baseUrl = url.replace(/\/+$/, '')
  }

  /** Update the base URL (e.g., when port changes). */
  updatePort(port: number): void {
    this.baseUrl = `http://localhost:${port}`
  }

  /** Set a custom base URL. */
  setBaseUrl(url: string): void {
    // Clean trailing slashes
    this.baseUrl = url.replace(/\/+$/, '')
  }

  /** Make a generic HTTP request to the server. */
  private request(method: string,path: string,body?: unknown): Promise<{ status: number, data: string }> {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : undefined
      const headers: Record<string, string> = {
        'Content-Type': 'application/json'
      }
      if (data) headers['Content-Length'] = Buffer.byteLength(data).toString()

      const req = http.request(
        `${this.baseUrl}${path}`,
        { method, headers },
        (res) => {
          let responseBody = ''
          res.on('data', (chunk) => { responseBody += chunk })
          res.on('end', () => {
            resolve({ status: res.statusCode ?? 0, data: responseBody })
          })
        }
      )
      req.on('error', reject)
      if (data) req.write(data)
      req.end()
    })
  }

  /** Check if the server is healthy. */
  async checkHealth(): Promise<boolean> {
    try {
      const { status, data } = await this.request('GET', '/v1/health')
      if (status === 200) {
        const health = JSON.parse(data) as HealthResponse
        Logger.info(`Server healthy. Loaded models: ${health.all_models_loaded.length}`)
        return true
      }
      return false
    } catch {
      return false
    }
  }

  /** Get the health response with details. */
  async getHealth(): Promise<HealthResponse> {
    const { status, data } = await this.request('GET', '/v1/health')
    if (status !== 200) throw new Error(`Health check failed: ${status} ${data}`)
    return JSON.parse(data) as HealthResponse
  }

  /**
   * List models known to the server.
   *
   * By default this returns only installed/downloaded models (the classic
   * `/v1/models` response). Pass `showAll = true` to fetch the server's full
   * model catalog via `?show_all=true` — like the desktop Model Manager — which
   * also includes suggested catalog entries that aren't downloaded yet. Each
   * entry is tagged with a `downloaded` boolean so callers can tell apart
   * what's available to pull from what's already installed.
   */
  async listModels(showAll = false): Promise<LemonadeModel[]> {
    const query = showAll ? '?show_all=true' : ''
    const { status, data } = await this.request('GET', `/v1/models${query}`)
    if (status !== 200) throw new Error(`Failed to list models: ${status} ${data}`)
    const response = JSON.parse(data) as { data: LemonadeModel[] }
    return response.data ?? []
  }

  async loadModel(modelName: string): Promise<void> {
    Logger.info(`Loading model: ${modelName}`)
    const { status, data } = await this.request('POST', '/v1/load', {
      model_name: modelName
    })
    if (status !== 200) {
      throw new Error(
        status === 409 && /slots_pinned_error/.test(data)
          ? 'A model of this type is already loaded. Unload it first via "Lemon: Unload Model".'
          : `Failed to load model: ${status} ${data}`
      )
    }
    Logger.info(`Model loaded: ${modelName}`)
  }

  async unloadModel(modelName?: string): Promise<void> {
    const body = modelName ? { model_name: modelName } : {}
    Logger.info(`Unloading model: ${modelName ?? 'all'}`)
    const { status, data } = await this.request('POST', '/v1/unload', body)
    if (status !== 200) {
      throw new Error(
        status === 409 && /slots_pinned_error/.test(data)
          ? 'This model is currently in use and cannot be unloaded right now.'
          : `Failed to unload model: ${status} ${data}`
      )
    }
    Logger.info(`Model unloaded: ${modelName ?? 'all'}`)
  }

  async unloadAllModels(): Promise<void> {
    await this.unloadModel()
  }

  /** Pull (download) a model from the server registry. */
  async pullModel(modelName: string, onProgress?: (progress: string) => void): Promise<void> {
    Logger.info(`Pulling model: ${modelName}`)

    // Use non-streaming pull for simplicity
    const { status, data } = await this.request('POST', '/v1/pull', {
      model_name: modelName,
      stream: false
    })

    if (status !== 200) throw new Error(`Failed to pull model: ${status} ${data}`)

    if (onProgress) onProgress('Model pulled successfully')
    Logger.info(`Model pulled: ${modelName}`)
  }

  /** Pull (download) a model using the streaming `/v1/pull` endpoint so callers
   * can display live download progress. `onProgress` is called for each event
   * with a percent (0-100, or -1 when the server doesn't report a ratio) and a
   * human-friendly message.
   */
  async pullModelStream(
    modelName: string,
    onProgress: (progress: { pct: number, written?: number, total?: number, message: string }) => void,
    signal?: AbortSignal
  ): Promise<void> {
    Logger.info(`Pulling model (streaming): ${modelName}`)
    const body = JSON.stringify({ model_name: modelName, stream: true })
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'Content-Length': Buffer.byteLength(body).toString()
    }

    return new Promise((resolve, reject) => {
      const req = http.request(
        `${this.baseUrl}/v1/pull`,
        { method: 'POST', headers },
        (res) => {
          Logger.info(`Pull response status: ${res.statusCode}`)
          Logger.info(`Pull response headers: ${JSON.stringify(res.headers)}`)

          if (res.statusCode !== 200) {
            let errorData = ''
            res.on('data', (chunk: Buffer) => { errorData += chunk.toString() })
            res.on('end', () => {
              reject(new Error(`Failed to pull model: ${res.statusCode} ${errorData}`))
            })
            return
          }

          let buffer = ''
          let dataReceived = false
          const handleLine = (line: string): void => {
            const trimmed = line.trim()
            if (!trimmed) return
            const jsonStr = trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed
            if (jsonStr === '[DONE]') {
              resolve()
              return
            }
            const { status, pct, written, total, message } = this.parsePullEvent(jsonStr)
            if (status === 'error') {
              reject(new Error(`Failed to pull model: ${message || modelName}`))
              return
            }
            if (pct >= 0) onProgress({ pct, written, total, message })
            else if (status !== 'done') onProgress({ pct: -1, written, total, message })
            if (status === 'done') resolve()
          }

          res.on('data', (chunk: Buffer) => {
            dataReceived = true
            // Logger.info(`Pull data chunk: ${chunk.toString().substring(0, 200)}`)
            buffer += chunk.toString()
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''
            for (const line of lines) handleLine(line)
          })

          res.on('end', () => {
            if (!dataReceived) Logger.warn('Pull response ended without receiving any data')
            if (buffer.trim()) handleLine(buffer)
            resolve()
          })

          res.on('error', (err) => {
            reject(new Error(`Stream error: ${err.message}`))
          })
        }
      )

      req.on('error', (err) => {
        reject(new Error(`Request error: ${err.message}`))
      })

      if (signal) {
        signal.addEventListener('abort', () => {
          req.destroy()
          reject(new Error('Model download cancelled'))
        }, { once: true })
      }

      req.write(body)
      req.end()
    })
  }

  /** Parse a single `/v1/pull` streaming event into a progress update. */
  private parsePullEvent(line: string):
    { status?: string, pct: number, written?: number, total?: number, message: string } {
    let parsed: PullStreamEvent & { percent?: number, bytes_downloaded?: number }
    try {
      parsed = JSON.parse(line)
    } catch {
      return { pct: -1, message: line }
    }

    let pct = -1
    const { progress, percent, bytes_written, bytes_downloaded, bytes_total } = parsed

    // Prefer `percent` field (0-100) sent by server
    if (typeof percent === 'number') pct = percent
    else if (typeof progress === 'number') {
      // Tolerate both a 0-1 fraction and a 0-100 percentage.
      pct = progress <= 1 ? progress * 100 : progress
    } else if (
      (typeof bytes_written === 'number' || typeof bytes_downloaded === 'number')
      && typeof bytes_total === 'number'
      && bytes_total > 0
    ) {
      const written = bytes_written ?? bytes_downloaded ?? 0
      const ratio = written / bytes_total
      pct = ratio * 100
    }
    if (pct >= 0) pct = Math.min(100, Math.max(0, pct))

    const message = typeof parsed.response === 'string' && parsed.response
      ? parsed.response
      : (parsed.status ?? '')
    return {
      status: parsed.status,
      pct,
      written: (bytes_written ?? bytes_downloaded) ?? (typeof bytes_total === 'number' ? 0 : undefined),
      total: typeof bytes_total === 'number' ? bytes_total : undefined,
      message
    }
  }

  async deleteModel(modelName: string): Promise<void> {
    Logger.info(`Deleting model: ${modelName}`)
    const { status, data } = await this.request('POST', '/v1/delete', {
      model_name: modelName
    })
    if (status !== 200) throw new Error(`Failed to delete model: ${status} ${data}`)
    Logger.info(`Model deleted: ${modelName}`)
  }

  /** Update server configuration (e.g., max_loaded_models). */
  async updateConfig(config: Record<string, unknown>): Promise<void> {
    Logger.info(`Updating server configuration: ${JSON.stringify(config)}`)
    const { status, data } = await this.request('POST', '/v1/config', config)
    if (status !== 200) throw new Error(`Failed to update config: ${status} ${data}`)
    Logger.info('Server configuration updated successfully')
  }

  /** Send a chat completion request (non-streaming). */
  async chatCompletion(
    request: ChatCompletionRequest
  ): Promise<ChatCompletionResponse> {
    const { status, data } = await this.request(
      'POST',
      '/v1/chat/completions',
      { ...request, stream: false }
    )
    if (status !== 200) throw new Error(`Chat completion failed: ${status} ${data}`)
    return JSON.parse(data) as ChatCompletionResponse
  }

  /**
   * Send a streaming chat completion request.
   * Calls onToken for each content chunk received.
   */
  async chatCompletionStream(
    request: ChatCompletionRequest,
    onToken: (token: string) => void,
    signal?: AbortSignal
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ ...request, stream: true })
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body).toString()
      }

      const req = http.request(
        `${this.baseUrl}/v1/chat/completions`,
        { method: 'POST', headers },
        (res) => {
          if (res.statusCode !== 200) {
            let errorData = ''
            res.on('data', (chunk) => { errorData += chunk })
            res.on('end', () => {
              reject(new Error(`Chat completion failed: ${res.statusCode} ${errorData}`))
            })
            return
          }

          let fullContent = ''
          let buffer = ''

          res.on('data', (chunk: Buffer) => {
            buffer += chunk.toString()
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''

            for (const line of lines) {
              const trimmed = line.trim()
              if (!trimmed || !trimmed.startsWith('data: ')) continue

              const jsonStr = trimmed.slice(6) // Remove 'data: ' prefix
              if (jsonStr === '[DONE]') {
                resolve(fullContent)
                return
              }

              try {
                const parsed = JSON.parse(jsonStr) as ChatCompletionResponse
                const delta = parsed.choices?.[0]?.delta
                if (delta?.content) {
                  fullContent += delta.content
                  onToken(delta.content)
                }
              } catch (err) {
                Logger.warn(`Failed to parse SSE chunk: ${err}`)
              }
            }
          })

          res.on('end', () => {
            // Process any remaining buffer
            if (buffer.trim().startsWith('data: ')) {
              const jsonStr = buffer.trim().slice(6)
              if (jsonStr === '[DONE]') {
                resolve(fullContent)
                return
              }
              try {
                const parsed = JSON.parse(jsonStr) as ChatCompletionResponse
                const delta = parsed.choices?.[0]?.delta
                if (delta?.content) {
                  fullContent += delta.content
                  onToken(delta.content)
                }
              } catch {
                // Ignore parse errors on final buffer
              }
            }
            resolve(fullContent)
          })

          res.on('error', (err) => {
            reject(new Error(`Stream error: ${err.message}`))
          })
        }
      )

      req.on('error', (err) => {
        reject(new Error(`Request error: ${err.message}`))
      })

      if (signal) {
        signal.addEventListener('abort', () => {
          req.destroy()
          reject(new Error('Request aborted'))
        })
      }

      req.write(body)
      req.end()
    })
  }

  /** Build a system prompt for code-related tasks. */
  static buildSystemPrompt(command?: string): string {
    const base = 'You are a helpful AI assistant running locally via Lemonade Server.'
    if (command === 'fix') {
      return `${base} The user wants you to fix issues in the provided code. `
        + 'Analyze the code, identify problems, and provide a corrected version with explanations.'
    }
    if (command === 'explain') {
      return `${base} The user wants you to explain the provided code. `
        + 'Provide a clear, detailed explanation of what the code does, '
        + 'how it works, and any notable patterns or issues.'
    }
    return base
  }

  /** Convert VS Code chat messages to OpenAI format. */
  /**
   * Convert VS Code chat messages to OpenAI format.
   * @param prompt The current user prompt.
   * @param history The chat history.
   * @param command Optional command to influence the system prompt.
   * @returns An array of chat messages in OpenAI format.
   */
  static toChatMessages(
    prompt: string,
    history: Array<{ role: string, content: string }>,
    command?: string
  ): ChatMessage[] {
    const messages: ChatMessage[] = [
      { role: 'system', content: LemonadeClient.buildSystemPrompt(command) }
    ]

    for (const msg of history) messages.push({ role: msg.role as 'user' | 'assistant', content: msg.content })
    messages.push({ role: 'user', content: prompt })
    return messages
  }
}
