import * as http from 'http'
import * as https from 'https'
import { Logger } from './logger'
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  DownloadProgressEvent,
  HealthResponse,
  LemonadeModel,
  OpenAIMessageToolCall,
  ParsedPullProgress,
  SystemInfoResponse
} from './interfaces'

/**
 * HTTP client for the Lemonade Server API.
 * Communicates with the local Lemonade Server using OpenAI-compatible endpoints.
 */
export class LemonadeClient {

  /** Inactivity timeout for plain (non-streaming) requests. */
  private static readonly REQUEST_TIMEOUT_MS = 15000

  /** Loading a multi-GB model from disk can take minutes of server silence. */
  private static readonly LOAD_TIMEOUT_MS = 10 * 60 * 1000

  /** Abort a chat stream after this much silence — arriving tokens reset it. */
  private static readonly STREAM_INACTIVITY_MS = 120000

  private baseUrl: string

  constructor(url: string) {
    // Trim and check for empty string
    if (url.trim().length === 0) throw new Error('URL cannot be empty or whitespace only.')
    this.baseUrl = url.replace(/\/+$/, '')
  }

  /** Pick the node HTTP module matching the base URL's protocol. */
  private get httpClient(): typeof http | typeof https {
    return this.baseUrl.startsWith('https://') ? https : http
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
  private request(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs: number = LemonadeClient.REQUEST_TIMEOUT_MS
  ): Promise<{ status: number, data: string }> {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : undefined
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (data) headers['Content-Length'] = Buffer.byteLength(data).toString()

      const req = this.httpClient.request(
        `${this.baseUrl}${path}`,
        { method, headers },
        (res) => {
          let responseBody = ''
          res.on('data', (chunk) => responseBody += chunk)
          res.on('end', () => resolve({ status: res.statusCode ?? 0, data: responseBody }))
        }
      )
      req.on('error', reject)
      // Inactivity guard: a hung server must not block status polling forever.
      req.setTimeout(timeoutMs, () =>
        req.destroy(new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`))
      )
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
    const { status, data } = await this.request(
      'POST',
      '/v1/load',
      { model_name: modelName },
      LemonadeClient.LOAD_TIMEOUT_MS
    )
    if (status !== 200) {
      let message = `Failed to load model: ${status} ${data}`

      // TODO: Not sure if these error exist
      if (/model_load_error/.test(data)) {
        message = 'The model files are incomplete or invalid. Remove the model and download it again.'
      } else if (status === 409 && /slots_pinned_error/.test(data)) {
        message = 'A model of this type is already loaded. Unload it first via "Chanh: Unload Model".'
      }
      throw new Error(message)
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

  /**
   * Read a model's saved, effective, and default recipe options
   * (`ctx_size`, backend, ...). Used to pre-fill the context-size dialog and
   * to show the model's default context length. Note: the server's response
   * key for the default layer is `defaults` (plural).
   */
  async getModelOptions(modelName: string): Promise<{
    saved?: Record<string, unknown>
    effective?: Record<string, unknown>
    defaults?: Record<string, unknown>
  }> {
    const { status, data } = await this.request('GET', `/v1/models/${encodeURIComponent(modelName)}/options`)
    if (status !== 200) throw new Error(`Failed to read model options: ${status} ${data}`)
    Logger.info(`Model options for ${modelName}: ${data}`)
    return JSON.parse(data)
  }

  /**
   * Save per-model recipe options (e.g. `{ ctx_size: 32768 }`) without loading
   * the model. The server merges this into its `recipe_options.json`, so the
   * value persists across restarts and applies at load time.
   */
  async setModelOptions(modelName: string, options: Record<string, unknown>): Promise<void> {
    const { status, data } = await this.request('POST', `/v1/models/${encodeURIComponent(modelName)}/options`, options)
    if (status !== 200) throw new Error(`Failed to save model options: ${status} ${data}`)
    Logger.info(`Saved options for ${modelName}: ${JSON.stringify(options)}`)
  }

  /** Reset a model's saved recipe options, restoring its defaults. */
  async resetModelOptions(modelName: string): Promise<void> {
    const { status, data } = await this.request('DELETE', `/v1/models/${encodeURIComponent(modelName)}/options`)
    if (status !== 200) throw new Error(`Failed to reset model options: ${status} ${data}`)
    Logger.info(`Reset options for ${modelName}`)
  }

  /** Pull (download) a model using the streaming `/v1/pull` endpoint so callers
   * can display live download progress. `onProgress` is called for each event
   * with a percent (0-100, or -1 when the server doesn't report a ratio) and a
   * human-friendly message.
   */
  async pullModelStream(
    modelName: string,
    onProgress: (progress: Omit<ParsedPullProgress, 'status'>) => void,
    signal?: AbortSignal
  ): Promise<void> {
    Logger.info(`Pulling model (streaming): ${modelName}`)
    const body = JSON.stringify({ model_name: modelName, stream: true })
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body).toString(),
      Accept: 'text/event-stream'
    }

    return new Promise((resolve, reject) => {
      const req = this.httpClient.request(
        `${this.baseUrl}/v1/pull`,
        { method: 'POST', headers },
        (res) => {
          Logger.info(`Pull response status: ${res.statusCode}`)
          Logger.info(`Pull response headers: ${JSON.stringify(res.headers)}`)

          if (res.statusCode !== 200) {
            let errorData = ''
            res.on('data', (chunk: Buffer) => errorData += chunk.toString())
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

          res.on('error', (err) => reject(new Error(`Stream error: ${err.message}`)))
        }
      )

      req.on('error', (err) => reject(new Error(`Request error: ${err.message}`)))

      if (signal) {
        signal.addEventListener('abort', () => {
          // Reject BEFORE destroy: destroy() fires an ECONNRESET 'error'
          // event that would otherwise report "socket hang up" instead.
          reject(new Error('Model download cancelled'))
          req.destroy()
        }, { once: true })
      }

      req.write(body)
      req.end()
    })
  }

  /** Parse a single `/v1/pull` streaming event into a progress update. */
  private parsePullEvent(line: string): ParsedPullProgress {
    let parsed: DownloadProgressEvent & { percent?: number, bytes_downloaded?: number }
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
    const { status, data } = await this.request('POST', '/v1/delete', { model_name: modelName })
    if (status !== 200) throw new Error(`Failed to delete model: ${status} ${data}`)
    Logger.info(`Model deleted: ${modelName}`)
  }

  /**
   * Fetch the server's capability report. This is the only source for backend
   * inventory: there is no `/v1/backends` endpoint, so the installed set is
   * derived by filtering `recipes.*.backends.*.state === 'installed'`.
   */
  async getSystemInfo(): Promise<SystemInfoResponse> {
    const { status, data } = await this.request('GET', '/v1/system-info')
    if (status !== 200) throw new Error(`Failed to read system info: ${status} ${data}`)
    Logger.info(`System info: ${Object.keys(JSON.parse(data).recipes ?? {}).length} recipes`)
    return JSON.parse(data)
  }

  /**
   * Install one backend for a recipe (`POST /v1/install`). Used when the user
   * picks a backend that `/v1/system-info` reports as `installable`.
   */
  async installBackend(recipe: string, backend: string, stream = false): Promise<void> {
    Logger.info(`Installing backend: ${recipe}:${backend}`)
    const { status, data } = await this.request('POST', '/v1/install', { recipe, backend, stream })
    if (status !== 200) throw new Error(`Failed to install ${recipe}:${backend}: ${status} ${data}`)
    Logger.info(`Backend installed: ${recipe}:${backend}`)
  }

  /**
   * Read the live server configuration (`GET /internal/config`). Returns the
   * merged config, including per-recipe sections such as `llamacpp.backend`.
   * This is the only way to read back a pinned backend: `/v1/config` does not
   * exist on the server.
   */
  async getConfig(): Promise<Record<string, unknown>> {
    const { status, data } = await this.request('GET', '/internal/config')
    if (status !== 200) throw new Error(`Failed to read config: ${status} ${data}`)
    return JSON.parse(data)
  }

  /**
   * Update server configuration (e.g., max_loaded_models, llamacpp.backend).
   *
   * The write endpoint is `POST /internal/set`, not `/v1/config`; the latter
   * returns 404. Verified against Lemonade Server 11.7.0. The change is applied
   * asynchronously, so a following `getConfig()` may briefly report the old
   * value.
   */
  async updateConfig(config: Record<string, unknown>): Promise<void> {
    Logger.info(`Updating server configuration: ${JSON.stringify(config)}`)
    const { status, data } = await this.request('POST', '/internal/set', config)
    if (status !== 200) throw new Error(`Failed to update config: ${status} ${data}`)
    Logger.info('Server configuration updated successfully')
  }

  /**
   * Send a streaming chat completion request.
   * Calls onToken for each content chunk received. Streamed tool-call deltas
   * are accumulated and emitted via onToolCall once the stream completes.
   */
  async chatCompletionStream(
    request: ChatCompletionRequest,
    onToken: (token: string) => void,
    signal?: AbortSignal,
    onToolCall?: (toolCall: OpenAIMessageToolCall) => void
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let settled = false
      let lastEvent = ''
      // Streamed tool calls arrive as chunks keyed by `index`.
      const toolCalls = new Map<number, { id: string, name: string, args: string }>()
      const finish = (content: string): void => {
        if (settled) return
        settled = true
        // Tool-call-only responses carry no text — still a valid response.
        if (!content && toolCalls.size === 0) {
          reject(new Error(
            `Chat completion returned no content from ${this.baseUrl} for model ${request.model}. ` +
            `Last server event: ${lastEvent || 'none'}`
          ))
          return
        }
        if (onToolCall) {
          const ordered = [...toolCalls.entries()].sort((a, b) => a[0] - b[0])
          for (const [, tc] of ordered) {
            onToolCall({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args } })
          }
        }
        resolve(content)
      }
      const fail = (error: Error): void => {
        if (settled) return
        settled = true
        reject(error)
      }
      const body = JSON.stringify({ ...request, stream: true })
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body).toString(),
        Accept: 'text/event-stream'
      }

      const req = this.httpClient.request(
        `${this.baseUrl}/v1/chat/completions`,
        { method: 'POST', headers },
        (res) => {
          if (res.statusCode !== 200) {
            let errorData = ''
            res.on('data', (chunk) => errorData += chunk)
            res.on('end', () => {
              fail(new Error(`Chat completion failed: ${res.statusCode} ${errorData}`))
            })
            return
          }

          let fullContent = ''
          let buffer = ''
          const processEvent = (event: string): void => {
            const trimmed = event.trim()
            if (!trimmed || !trimmed.startsWith('data: ')) return

            const jsonStr = trimmed.slice(6)
            if (jsonStr === '[DONE]') {
              finish(fullContent)
              return
            }
            lastEvent = jsonStr.slice(0, 500)

            try {
              const parsed = JSON.parse(jsonStr) as ChatCompletionResponse & {
                error?: { message?: string } | string
                detail?: string
              }
              const serverError = typeof parsed.error === 'string'
                ? parsed.error
                : parsed.error?.message ?? parsed.detail
              if (serverError) {
                fail(new Error(`Chat completion failed: ${serverError}`))
                return
              }
              const choice = parsed.choices?.[0]
              const content = choice?.delta?.content
                ?? choice?.delta?.reasoning_content
                ?? choice?.message?.content
              if (typeof content === 'string' && content) {
                fullContent += content
                onToken(content)
              }
              const deltaCalls = choice?.delta?.tool_calls as
                | Array<{ index?: number, id?: string, function?: { name?: string, arguments?: string } }>
                | undefined
              for (const dc of deltaCalls ?? []) {
                const idx = dc.index ?? 0
                const acc = toolCalls.get(idx) ?? { id: '', name: '', args: '' }
                if (dc.id) acc.id = dc.id
                if (dc.function?.name) acc.name += dc.function.name
                if (dc.function?.arguments) acc.args += dc.function.arguments
                toolCalls.set(idx, acc)
              }
            } catch (err) {
              Logger.warn(`Failed to parse SSE chunk: ${err}`)
            }
          }

          res.on('data', (chunk: Buffer) => {
            buffer += chunk.toString()
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''
            for (const line of lines) processEvent(line)
          })

          res.on('end', () => {
            processEvent(buffer)
            finish(fullContent)
          })

          res.on('error', (err) => {
            fail(new Error(`Stream error: ${err.message}`))
          })
        }
      )

      req.on('error', (err) => {
        fail(new Error(`Request error: ${err.message}`))
      })

      // Watchdog: socket inactivity (no tokens, no headers) means the server
      // is hung mid-generation — fail instead of spinning forever. Any byte
      // on the socket resets the timer, so slow-but-streaming is unaffected.
      req.setTimeout(LemonadeClient.STREAM_INACTIVITY_MS, () => {
        const timeoutSeconds = LemonadeClient.STREAM_INACTIVITY_MS / 1000
        fail(new Error(`Stream went silent for ${timeoutSeconds}s — the server may be hung`))
        req.destroy()
      })

      if (signal) {
        signal.addEventListener('abort', () => {
          // Reject/fail BEFORE destroy: destroy() fires an ECONNRESET 'error'
          // event that would otherwise win the race and report
          // "Request error: socket hang up" instead of the abort message.
          fail(new Error('Request aborted'))
          req.destroy()
        }, { once: true })
      }

      req.write(body)
      req.end()
    })
  }

  /** Build a system prompt for code-related tasks. TODO: better prompt? */
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
    const messages: ChatMessage[] = [{ role: 'system', content: LemonadeClient.buildSystemPrompt(command) }]

    for (const msg of history) messages.push({ role: msg.role as 'user' | 'assistant', content: msg.content })
    messages.push({ role: 'user', content: prompt })
    return messages
  }
}
