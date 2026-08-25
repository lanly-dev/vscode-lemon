export enum ServerStatus {
  RUNNING = 'RUNNING',
  STARTING = 'STARTING',
  STOPPED = 'STOPPED',
  ERROR = 'ERROR',
}

/** The user-selected Lemonade server to target for chat and model operations. */
export enum TargetServer {
  STANDALONE = 'standalone',
  EMBEDDED = 'embedded',
  CUSTOM = 'custom',
}

/** A chat message in OpenAI format. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** Request body for `/v1/chat/completions`. */
export interface ChatCompletionRequest {
  model: string
  messages: ChatMessage[]
  stream?: boolean
  temperature?: number
  max_tokens?: number
  top_p?: number
}

/** A single choice in a chat completion response. */
export interface ChatChoice {
  index: number
  message?: ChatMessage
  delta?: Partial<ChatMessage>
  finish_reason?: string | null
}

/** Non-streaming chat completion response. */
export interface ChatCompletionResponse {
  id: string
  object: string
  created: number
  model: string
  choices: ChatChoice[]
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

/**
 * Number of pinned models per category, as reported by `/v1/health`.
 */
export interface PinnedModels {
  classification?: number
  embedding?: number
  image?: number
  llm?: number
  reranking?: number
  transcription?: number
  tts?: number
}
/** Health response from `/v1/health`. */
export interface HealthResponse {
  model_loaded: string | null
  all_models_loaded: Array<{
    model_name: string
    is_busy: boolean
    is_streaming: boolean
    backend_url?: string
  }>
  max_loaded_models?: number
  pinned_models?: PinnedModels
}

/** Information about a GitHub release. */
export interface GitHubRelease {
  tag_name: string
  name: string
  assets: ReleaseAsset[]
}

/** A model entry returned by the Lemonade Server `/v1/models` endpoint. */
export interface LemonadeModel {
  id: string
  object?: string
  created?: number
  owned_by?: string
  /** Category labels of the model (e.g. ["transcription"], ["image"], ["chat"]). */
  labels?: string[]
  /** Human-friendly primary label derived from `labels`. */
  label?: string
  /** Machine-readable model type from the server. */
  type?: string
  /** Recipe (backend) used to load/run the model, e.g. "llamacpp". */
  recipe?: string
  /** Suggested models come from the server's built-in catalog: they are pullable but may not be downloaded yet. */
  suggested?: boolean
  /** Whether the model is already downloaded on disk (present when using `?show_all=true`). */
  downloaded?: boolean
  /** Whether an update is available for the model upstream. */
  update_available?: boolean
    /** Approximate model size in GB, when reported by the server. */
  size?: number
}

export interface ModelTreeItem {
  id: string
  label: string
  loaded: boolean
  description?: string
}

/** Information about a Lemonade Server release asset. */
export interface ReleaseAsset {
  name: string
  browser_download_url: string
  size: number
}

/** A server instance shown in the tree view. */
export interface ServerInstance {
  id: string
  name: string
  url: string
  status: ServerStatus
  version?: string
  health?: HealthResponse
  models?: LemonadeModel[]
  error?: string
  maxLoadedModels?: number
}
