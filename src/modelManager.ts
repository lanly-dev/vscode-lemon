import { ConfigurationTarget, ProgressLocation, QuickPickItem, ViewColumn } from 'vscode'
import { window, workspace } from 'vscode'

import { formatSize } from './utils'
import { LemonadeModel, ServerStatus, SystemInfoResponse } from './interfaces'
import { Logger } from './logger'
import { ServerManager } from './serverManager'

import type { ChanhLmcProvider } from './lmcProvider'
import type { ChatParticipant } from './chatParticipant'
import type { LemonadeClient } from './lemonadeClient'
import type { ServerViewProvider } from './serverTreeview'

const { showErrorMessage, showInformationMessage, showQuickPick, showWarningMessage } = window

/**
 * Encapsulates model operations (load, unload, delete, select, max-loaded)
 * against the Lemonade Server. Model logic is kept out of {@link ServerManager}
 * so the server lifecycle manager stays focused on process management.
 */
export class ModelManager {

  /**
   * Build the subtext shown alongside a model in the tree view.
   *
   * Uses the model's `labels` verbatim (no hardcoded category knowledge), joined
   * by ", ". Falls back to `owned_by`, then `type`. Returns undefined when none
   * of those are present so callers can omit the subtext entirely.
   */
  static getModelLabel(model: Pick<LemonadeModel, 'labels' | 'type' | 'owned_by'>): string | undefined {
    const labels = model.labels
    if (labels && labels.length > 0) return labels.join(', ')
    if (model.owned_by) return model.owned_by
    return model.type
  }

  /** Canonical capability category for a raw model label/type, when recognized. */
  private static capabilityFor(raw: string): string | undefined {
    const l = raw.toLowerCase()
    if (l === 'chat' || l === 'llm') return 'llm'
    // Lemonade labels embedding models with the plural "embeddings".
    if (l === 'embeddings') return 'embedding'
    if (l === 'reranking') return 'reranking'
    if (l === 'classification') return 'classification'
    if (l === 'transcription') return 'transcription'
    if (l === 'tts' || l.includes('speech')) return 'tts'
    // `image` (generation) and `vision` (image input) share one tree group by
    // design; the agent picker still distinguishes them (`vision` alone sets
    // `imageInput` in `lmcProvider.ts`).
    if (l === 'image' || l.includes('vision')) return 'image'
    if (l === '3d') return '3d'
    return undefined
  }

  /** Whether the model carries the server's "hot" marker label. */
  static isHotModel(model: Pick<LemonadeModel, 'labels'>): boolean {
    return (model.labels ?? []).some((l) => l.toLowerCase() === 'hot')
  }

  /**
   * Map a model's capability labels to ALL matching capability categories,
   * deduped in match order. Category names double as the SVG filenames under
   * media/capabilities/. Returns an empty array when nothing matches.
   */
  static getCapabilityCategories(model: Pick<LemonadeModel, 'labels' | 'type'>): string[] {
    const categories: string[] = []
    for (const label of [...(model.labels ?? []), model.type ?? '']) {
      const category = ModelManager.capabilityFor(label)
      if (category && !categories.includes(category)) categories.push(category)
    }
    return categories
  }

  constructor(
    private serverManager: ServerManager,
    private treeViewProvider: ServerViewProvider,
    private lmcProvider?: ChanhLmcProvider
  ) { }

  /** Preset context sizes offered in the Set Context Size quick pick. */
  private static readonly QUICK_CTX_SIZES = [
    { label: '8K', tokens: 8192 },
    { label: '16K', tokens: 16384 },
    { label: '32K', tokens: 32768 },
    { label: '48K', tokens: 49152 }
  ]

  /** Lower bound (4K) for a custom context size entry. */
  private static readonly MIN_CUSTOM_CTX = 4096

  /** The client bound to the currently active server. */
  private get client() {
    return this.serverManager.client
  }

  async loadModel(modelName: string): Promise<void> {
    if (!await this.serverManager.ensureRunning()) return

    try {
      await window.withProgress(
        {
          location: ProgressLocation.Notification,
          title: `Loading model: ${modelName}`,
          cancellable: false
        },
        async (progress) => {
          progress.report({ message: 'Loading...' })
          await this.client.loadModel(modelName)
        }
      )
      showInformationMessage(`Model '${modelName}' loaded successfully`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : `Failed to load model: ${String(err)}`
      Logger.error(message, err)
      showErrorMessage(message)
    }
    // Loaded-models state changed, so re-query the server before repainting.
    this.treeViewProvider.refreshServer()
  }

  /**
   * The backend pinned in the live server config for a recipe, or undefined
   * when the recipe is on `auto` or the config cannot be read.
   */
  private async readPinnedBackend(recipe: string): Promise<string | undefined> {
    try {
      const config = await this.client.getConfig()
      const section = config[recipe]
      if (section && typeof section === 'object') {
        const backend = (section as Record<string, unknown>).backend
        if (typeof backend === 'string' && backend !== 'auto') return backend
      }
      return undefined
    } catch (err: unknown) {
      Logger.warn(`Could not read pinned backend for ${recipe}: ${err}`)
      return undefined
    }
  }

  /**
   * Pick which backend (accelerator) a model's recipe should use, and pin it on
   * the server. Only backends `/v1/system-info` reports as usable are offered;
   * an `installable` one is installed on confirmation, while an `unsupported`
   * one is never shown. The choice is server-wide for the recipe, not per model.
   */
  async selectBackend(item: { modelId?: string }): Promise<void> {
    const modelId = item.modelId
    if (!modelId) {
      showErrorMessage('Missing model ID, please report this bug to the developers')
      return
    }
    if (!await this.serverManager.ensureRunning()) return

    let recipe: string | undefined
    try {
      const models = await this.client.listModels()
      recipe = models.find((m) => m.id === modelId)?.recipe
    } catch (err: unknown) {
      Logger.warn(`Could not read recipe for ${modelId}: ${err}`)
    }
    if (!recipe) {
      showWarningMessage(`The server did not report a recipe for '${modelId}', so no backend can be chosen.`)
      return
    }

    let info: SystemInfoResponse
    try {
      info = await this.client.getSystemInfo()
    } catch (err: unknown) {
      Logger.error('Failed to read system info', err)
      showErrorMessage(`Failed to read backend information: ${err}`)
      return
    }

    const recipeInfo = info.recipes?.[recipe]
    const entries = Object.entries(recipeInfo?.backends ?? {}).filter(([, b]) => b.state !== 'unsupported')
    if (entries.length === 0) {
      showWarningMessage(`No usable backend is available for '${recipe}' on this machine.`)
      return
    }

    // Show the pinned backend as the current selection when one is set, and the
    // server's `auto` default otherwise. Read live from `/internal/config`
    // because the pinned value is not visible in `/v1/system-info`.
    const current = await this.readPinnedBackend(recipe) ?? recipeInfo?.default_backend
    const items: Array<QuickPickItem & { backend: string, installed: boolean }> = entries.map(
      ([name, backend]) => ({
        label: `${name}${name === current ? ' — current' : ''}${name === recipeInfo?.default_backend ? ' (auto)' : ''}`,
        description: backend.state === 'installed' ? 'Installed' : 'Installable',
        detail: [backend.version ? `v${backend.version}` : undefined]
          .concat(backend.devices?.length ? [backend.devices.join(', ')] : [])
          .filter(Boolean)
          .join(' · '),
        backend: name,
        installed: backend.state === 'installed'
      })
    )

    const picked = await showQuickPick(items, {
      title: `Select backend for ${modelId}`,
      placeHolder: `Recipe: ${recipe}. Applies to every model using this recipe.`
    })
    if (!picked) return

    // A backend that is not installed yet cannot be selected: install it first.
    if (!picked.installed) {
      const action = await showWarningMessage(
        `The '${picked.backend}' backend is not installed. Install it before using it for '${recipe}'.`,
        'Install Now',
        'Cancel'
      )
      if (action !== 'Install Now') return
      try {
        const installTitle = `Installing ${recipe}:${picked.backend}`
        await window.withProgress(
          { location: ProgressLocation.Notification, title: installTitle, cancellable: false },
          async (progress) => {
            progress.report({ message: 'Downloading...' })
            await this.client.installBackend(recipe, picked.backend)
          }
        )
      } catch (err: unknown) {
        Logger.error('Failed to install backend', err)
        showErrorMessage(`Failed to install backend '${picked.backend}': ${err}`)
        return
      }
      // Backends changed, so the cached report and the tree need a refresh.
      this.treeViewProvider.refreshServer()
    }

    // Pin the recipe to the chosen backend through the server's config API.
    // `auto` restores the server's own default selection.
    try {
      await this.client.updateConfig({ [recipe]: { backend: picked.backend } })
      this.treeViewProvider.refreshServer()
      showInformationMessage(
        `'${recipe}' backend set to '${picked.backend}'. Restart the server to apply it.`
      )
    } catch (err: unknown) {
      Logger.error('Failed to set backend', err)
      showErrorMessage(`Failed to set backend '${picked.backend}': ${err}`)
    }
  }

  async unloadModel(modelName: string): Promise<void> {
    if (!await this.serverManager.ensureRunning()) return
    const name = modelName

    try {
      await window.withProgress(
        {
          location: ProgressLocation.Notification,
          title: `Unloading model: ${name}`,
          cancellable: false
        },
        async (progress) => {
          progress.report({ message: 'Unloading...' })
          await this.client.unloadModel(name)
        }
      )
      showInformationMessage(`Model '${name}' unloaded successfully`)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : `Failed to unload model: ${String(err)}`
      Logger.error(message, err)
      showErrorMessage(message)
    }
    // Loaded-models state changed, so re-query the server before repainting.
    this.treeViewProvider.refreshServer()
  }

  /** Parse an effective/default ctx_size out of a model options response. */
  private static readCtxSize(options: Record<string, unknown> | undefined): number | undefined {
    const value = options?.ctx_size
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }

  /**
   * Shared flow for context-size changes: persist the option, auto-reload the
   * model when it is loaded (saved ctx_size only applies at load time), then
   * refresh the tree and the VS Code model picker so its token budget matches.
   */
  private async applyContextChange(
    modelId: string,
    change: { kind: 'set', ctxSize: number } | { kind: 'reset' }
  ): Promise<void> {
    try {
      await window.withProgress(
        {
          location: ProgressLocation.Notification,
          title: `Updating context size for: ${modelId}`,
          cancellable: false
        },
        async (progress) => {
          progress.report({ message: 'Saving...' })
          if (change.kind === 'set') await this.client.setModelOptions(modelId, { ctx_size: change.ctxSize })
          else await this.client.resetModelOptions(modelId)

          // Saved options apply at load time — reload automatically if the
          // model is currently loaded so the change takes effect immediately.
          const health = await this.client.getHealth()
          if (health.all_models_loaded.some((loaded) => loaded.model_name === modelId)) {
            progress.report({ message: 'Reloading...' })
            await this.client.unloadModel(modelId)
            try {
              await this.client.loadModel(modelId)
            } catch (err: unknown) {
              throw new Error(`Context size was saved, but reloading '${modelId}' failed: ${err}`)
            }
          }

          // Re-query /v1/models so VS Code's token budget picks up the new context.
          this.lmcProvider?.refresh()
        }
      )
      showInformationMessage(
        change.kind === 'set'
          ? (change.ctxSize === -1
            ? `Model '${modelId}' will use automatic context sizing`
            : `Context size for '${modelId}' set to ${change.ctxSize.toLocaleString()} tokens`)
          : `Model '${modelId}' reset to its default context size`
      )
    } catch (err: unknown) {
      Logger.error('Failed to update context size', err)
      showErrorMessage(`Failed to update context size: ${err}`)
    }
    // Model metadata/load state changed, so re-query the server before repainting.
    this.treeViewProvider.refreshServer()
  }

  /** Prompt for a context size and persist it for the given model. */
  async setModelContext(item?: { modelId?: string }): Promise<void> {
    const modelId = item?.modelId

    if (!modelId) {
      showErrorMessage('Missing model ID, please report this bug to the developers')
      return
    }

    // Can you set this when lemond is stopped?
    if (!await this.serverManager.ensureRunning()) return

    let effective: number | undefined
    let defaultCtx: number | undefined
    try {
      const options = await this.client.getModelOptions(modelId)
      effective = ModelManager.readCtxSize(options.effective)
      // The server reports the default layer under `defaults` (plural).
      defaultCtx = ModelManager.readCtxSize(options.defaults)
    } catch (err: unknown) {
      Logger.warn(`Could not read options for ${modelId}: ${err}`)
    }
    // No fallbacks: if the server doesn't report a context number, leave the
    // input empty so the user isn't shown an invented value.
    if (defaultCtx) Logger.info(`Default context for ${modelId}: ${defaultCtx}`)

    // The model's supported ceiling (4K floor for custom entries). Without a
    // reported max_context_window the custom field stays unconstrained upward.
    let maxCtx: number | undefined
    try {
      const models = await this.client.listModels()
      const max = models.find((m) => m.id === modelId)?.max_context_window
      if (typeof max === 'number' && max > 0) maxCtx = max
    } catch (err: unknown) {
      Logger.warn(`Could not read max context window for ${modelId}: ${err}`)
    }

    const pick = await this.promptContextSize(modelId, effective, defaultCtx, maxCtx)
    if (pick === undefined) return

    if (pick === 'custom') {
      const minCtx = ModelManager.MIN_CUSTOM_CTX
      const minCtxString = minCtx.toLocaleString()

      const rangeHint = maxCtx && maxCtx > 0
        ? ` (${minCtxString} - ${maxCtx.toLocaleString()} tokens)`
        : ` (at least ${minCtxString} tokens)`

      const input = await window.showInputBox({
        title: `Custom context size for ${modelId}`,
        prompt: `Tokens in${rangeHint}. -1 for automatic sizing`,
        value: effective && effective > 0 ? String(effective) : undefined,
        placeHolder: defaultCtx && defaultCtx > 0 ? String(defaultCtx) : 'e.g. 4096',
        validateInput: (raw) => {
          const trimmed = raw.trim()
          if (!/^-?\d+$/.test(trimmed)) return 'Enter a whole number of tokens (or -1 for automatic).'
          const n = Number(trimmed)
          if (n === 0 || n < -1) return 'Enter -1 (automatic) or a positive number.'
          if (n !== -1 && n < minCtx) return `Minimum is ${minCtxString} tokens (4K).`
          if (maxCtx && n > maxCtx) return `Maximum for this model is ${maxCtx.toLocaleString()} tokens.`

          return undefined
        }
      })
      if (input === undefined) return
      await this.applyContextChange(modelId, { kind: 'set', ctxSize: Number(input.trim()) })
      return
    }

    await this.applyContextChange(modelId, { kind: 'set', ctxSize: pick })
  }

  /**
   * Quick-pick of common context sizes up to the model's supported maximum
   * (with the current/default marked), an automatic option, and a
   * custom-number entry bounded by [4K, max].
   * Returns the chosen size in tokens, -1 for automatic, 'custom' to ask for
   * a specific number, or undefined when cancelled.
   */
  private async promptContextSize(
    modelId: string,
    effective: number | undefined,
    defaultCtx: number | undefined,
    maxCtx?: number
  ): Promise<number | 'custom' | undefined> {
    const mark = (tokens: number): string => {
      const tags: string[] = []
      if (effective === tokens) tags.push('current')
      if (defaultCtx === tokens) tags.push('default')
      return tags.length ? ` — ${tags.join(', ')}` : ''
    }

    const items: Array<QuickPickItem & { value: number | 'custom' }> = [
      ...ModelManager.QUICK_CTX_SIZES
        .filter((size) => !maxCtx || size.tokens <= maxCtx)
        .map((size) => ({
          label: `${size.label} — ${size.tokens.toLocaleString()} tokens${mark(size.tokens)}`,
          value: size.tokens
        })),
      {
        label: 'Automatic',
        description: 'Server decides the context size (-1)',
        value: -1
      },
      {
        label: 'Custom…',
        description: maxCtx && maxCtx > 0
          ? `Any value from 4K up to ${maxCtx.toLocaleString()} tokens`
          : 'Enter a specific number of tokens (at least 4K)',
        value: 'custom'
      }
    ]

    const picked = await window.showQuickPick(items, {
      title: `Context size for ${modelId}`,
      placeHolder: 'Choose the context size to apply'
    })
    return picked?.value
  }

  /** Clear a model's saved context size, restoring its default. */
  async resetModelContext(item?: { modelId?: string }): Promise<void> {
    const modelId = item?.modelId
    if (!modelId) {
      showErrorMessage('Right-click a model in the Chanh view to reset its context size')
      return
    }
    if (!await this.serverManager.ensureRunning()) return
    await this.applyContextChange(modelId, { kind: 'reset' })
  }

  /**
   * Extract the request/context sizes from the server's context-overflow
   * error, e.g. "...request (7270 tokens) exceeds the available context size
   * (4096 tokens), try increasing it".
   */
  static detectContextOverflow(err: unknown): { used: number, available: number } | undefined {
    const message = err instanceof Error ? err.message : String(err)
    const match = message.match(/request \((\d+) tokens\) exceeds the available context size \((\d+) tokens\)/)
    if (!match) return undefined
    return { used: Number(match[1]), available: Number(match[2]) }
  }

  /**
   * When a chat completion fails because the prompt exceeds the model's
   * context size, offer the user a one-click way to raise it.
   */
  async offerContextIncrease(modelId: string, err: unknown): Promise<void> {
    const overflow = ModelManager.detectContextOverflow(err)
    if (!overflow) return
    Logger.warn(`Context overflow on '${modelId}': request ${overflow.used} tokens > ${overflow.available} tokens`)
    const action = await window.showWarningMessage(
      `'${modelId}' has a ${overflow.available.toLocaleString()}-token context size, but the request `
      + `needs ${overflow.used.toLocaleString()} tokens. Set a larger context size?`,
      'Set Context Size'
    )
    if (action === 'Set Context Size') await this.setModelContext({ modelId })
  }

  /**
   * Show every server-reported detail for a model in a popup panel:
   * capabilities, size, context (effective/saved/default), recipe, ownership,
   * add date, and current runtime state when loaded.
   */
  async showModelInfo(item?: { modelId?: string }): Promise<void> {
    const modelId = item?.modelId
    if (!modelId) {
      showErrorMessage('Right-click a model in the Chanh view to show its info')
      return
    }
    if (!await this.serverManager.ensureRunning()) return

    try {
      // Options and health are best-effort: older servers may not expose them.
      const [models, health, options] = await Promise.all([
        this.client.listModels(),
        this.client.getHealth().catch(() => undefined),
        this.client.getModelOptions(modelId).catch(() => undefined)
      ])
      const model = models.find((m) => m.id === modelId)
      if (!model) {
        showErrorMessage(`Model '${modelId}' was not found on the server`)
        return
      }
      const loaded = health?.all_models_loaded.find((m) => m.model_name === modelId)
      // Log the raw server data so missing fields can be diagnosed from the
      // Chanh output channel.
      Logger.info(`Model entry for ${modelId}: ${JSON.stringify(model)}`)

      const panel = window.createWebviewPanel('chanhModelInfo', modelId, ViewColumn.Active, { enableScripts: false })
      panel.webview.html = this.buildModelInfoHtml(model, options, loaded)
    } catch (err: unknown) {
      Logger.error('Failed to show model info', err)
      showErrorMessage(`Failed to show model info: ${err}`)
    }
  }

  /** Render the model-info popup as a self-contained HTML page. */
  private buildModelInfoHtml(
    model: LemonadeModel,
    options?: Awaited<ReturnType<LemonadeClient['getModelOptions']>>,
    loaded?: { is_busy?: boolean, is_streaming?: boolean, backend_url?: string }
  ): string {
    const esc = (value: unknown): string => String(value ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const row = (label: string, value?: string): string | undefined => {
      if (!value) return undefined
      return `<div class="row"><span class="label">${esc(label)}</span>` +
        `<span class="value">${esc(value)}</span></div>`
    }

    // -1 means "automatic context sizing"; missing values render as empty.
    // No fallbacks: only what the server actually reports is shown.
    const fmtCtx = (n?: number): string => {
      if (n === -1) return 'Automatic'
      return n !== undefined && n > 0 ? `${n.toLocaleString()} tokens` : ''
    }

    const effectiveCtx = ModelManager.readCtxSize(options?.effective)
    const savedCtx = ModelManager.readCtxSize(options?.saved)
    // The server reports the default layer under `defaults` (plural).
    const defaultCtx = ModelManager.readCtxSize(options?.defaults)

    const rows = [
      row('Capabilities', ModelManager.getModelLabel(model)),
      row('Status', loaded
        ? ['Loaded', loaded.is_busy ? 'busy' : 'idle', loaded.is_streaming ? 'streaming' : undefined]
          .filter(Boolean).join(' — ')
        : 'Downloaded (not loaded)'),
      row('Size', formatSize(model.size)),
      row('Context (effective)', fmtCtx(effectiveCtx)),
      row('Context (reported)', fmtCtx(model.context_length)),
      row('Max context window', fmtCtx(model.max_context_window)),
      row('Context (saved override)', savedCtx === undefined ? '' : fmtCtx(savedCtx)),
      row('Context (default)', fmtCtx(defaultCtx)),
      row('Checkpoint', model.checkpoint),
      row('Registry', model.registry_source),
      row('Recipe', model.recipe),
      row('Type', model.type),
      row('Owned by', model.owned_by),
      row('Created', typeof model.created === 'number' && model.created > 0
        ? new Date(model.created * 1000).toISOString().slice(0, 10)
        : undefined),
      row('Created value', model.created?.toString()),
      row('Backend', loaded?.backend_url)
    ].filter((r): r is string => r !== undefined)

    const labels = (model.labels ?? []).map((l) => `<span class="chip">${esc(l)}</span>`).join(' ')
    const updateNote = model.update_available
      ? '<div class="note">&#9888; An update is available upstream — pull the model again to update it.</div>'
      : ''

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground);
         padding: 12px 16px; font-size: var(--vscode-font-size); }
  h2 { margin: 0 0 4px; font-weight: 600; }
  .sub { color: var(--vscode-descriptionForeground); margin-bottom: 12px; }
  .chip { display: inline-block; margin: 0 4px 4px 0; padding: 1px 8px;
          border: 1px solid var(--vscode-panel-border); border-radius: 8px;
          font-size: 0.85em; color: var(--vscode-descriptionForeground); }
  .row { display: flex; padding: 5px 0; border-bottom: 1px solid var(--vscode-panel-border); }
  .label { width: 190px; flex: none; color: var(--vscode-descriptionForeground); }
  .value { white-space: pre-wrap; word-break: break-word; }
  .note { margin-top: 12px; padding: 8px 10px; border-radius: 4px;
          background: var(--vscode-inputValidation-warningBackground); }
</style>
</head>
<body>
  <h2>${esc(model.id)}</h2>
  <div class="sub">${labels || 'Local model served by Lemonade Server'}</div>
  ${rows.join('\n  ')}
  ${updateNote}
</body>
</html>`
  }

  /**
   * Delete a downloaded model from disk on the active server.
   */
  async deleteModel(modelName: string): Promise<void> {
    if (!await this.serverManager.ensureRunning()) return

    try {
      const confirm = await window.showWarningMessage(
        `Delete model '${modelName}' from disk? This cannot be undone.`,
        { modal: true },
        'Delete'
      )
      if (confirm !== 'Delete') return

      await window.withProgress(
        {
          location: ProgressLocation.Notification,
          title: `Deleting model: ${modelName}`,
          cancellable: false
        },
        async (progress) => {
          progress.report({ message: 'Deleting...' })
          await this.client.deleteModel(modelName)
        }
      )
      this.treeViewProvider.clearPartial(modelName)
      // The model moved off disk, so re-query the server before repainting.
      this.treeViewProvider.refreshServer()
      showInformationMessage(`Model '${modelName}' deleted successfully`)
    } catch (err: unknown) {
      Logger.error('Failed to delete model', err)
      showErrorMessage(`Failed to delete model: ${err}`)
    }
  }

  /**
   * Prompt the user for a new maximum number of concurrently loaded models,
   * persist the value to the chanh.maxLoadedModels config, and if the bundled
   * lemond server is running, push it to the running server immediately.
   */
  async setMaxLoadedModels(): Promise<void> {
    const config = workspace.getConfiguration('chanh')
    const current = config.get<number>('maxLoadedModels', 1)
    const currentText = current === -1 ? 'Unlimited' : String(current)

    const value = await window.showInputBox({
      title: 'Set Max Loaded Models',
      prompt: `Current: ${currentText}. Enter the maximum number of loaded models (-1 for unlimited).`,
      placeHolder: 'e.g. 1 or -1 for unlimited',
      value: String(current),
      validateInput: (input) => {
        const trimmed = input.trim()
        if (trimmed === '') return 'Please enter a number'
        const n = Number(trimmed)
        if (!Number.isInteger(n) || n < -1) return 'Enter an integer of -1 or greater (-1 = unlimited)'
        return undefined
      }
    })
    if (value === undefined || value.trim() === '') return

    const n = Number(value)
    try {
      await config.update('maxLoadedModels', n, ConfigurationTarget.Global)
      Logger.info(`Set chanh.maxLoadedModels to ${n}`)

      if (this.serverManager.status === ServerStatus.RUNNING) {
        await this.client.updateConfig({ max_loaded_models: n })
        Logger.info('Pushed max_loaded_models to running server')
      }

      showInformationMessage(`Max loaded models set to ${n === -1 ? 'unlimited' : n}`)
      // Server config changed, so re-query before repainting.
      this.treeViewProvider.refreshServer()
    } catch (err: unknown) {
      Logger.error('Failed to set max loaded models', err)
      showErrorMessage(`Failed to set max loaded models: ${err}`)
    }
  }

  /**
   * Select an active model for chat.
   * Prompts the user to pick a model from the available ones.
   * Resolves to the selected model name, or undefined if cancelled/error.
   */
  async selectChatModel(chatParticipant: ChatParticipant): Promise<void> {
    if (!await this.serverManager.ensureRunning()) return undefined
    const selected = await this.promptForModel(
      'Select active model for chat',
      (m) => m.labels?.includes('chat') ?? false,
      'No chat models available. Download a chat model first.'
    )
    if (!selected) return
    try {
      await this.client.loadModel(selected)
    } catch (err) {
      Logger.error('Failed to load selected chat model', err)
      showErrorMessage(`Failed to load chat model: ${err}`)
      return
    }
    chatParticipant.setSelectedModel(selected)
    showInformationMessage(`Selected model for chat: ${selected}`)
  }

  /** Show a quick pick of the available models and return the selected model name. */
  private async promptForModel(
    title: string,
    filter?: (model: LemonadeModel) => boolean,
    emptyMessage?: string
  ): Promise<string | undefined> {
    try {
      let models = await this.client.listModels()
      if (filter) models = models.filter(filter)
      if (models.length === 0) {
        showWarningMessage(emptyMessage ?? 'No models available. Pull a model first.')
        return undefined
      }
      const items: QuickPickItem[] = models.map((m) => ({
        label: m.id,
        description: ModelManager.getModelLabel(m) ?? m.owned_by ?? ''
      }))
      const selected = await showQuickPick(items, { title, placeHolder: 'Choose a model' })
      return selected?.label
    } catch (err: unknown) {
      Logger.error('Failed to list models', err)
      showErrorMessage(`Failed to list models: ${err}`)
      return undefined
    }
  }

  /**
   * Pull a specific model by id, showing live progress in a cancellable popup
   * and tracking incomplete downloads in the tree view on cancel/failure.
   * Invoked from a Downloadable Models tree row (click or inline icon).
   */
  async downloadModel(item: { modelId: string }): Promise<void> {
    const modelId = item.modelId
    if (!await this.serverManager.ensureRunning()) {
      // UI won't allow this case
      showWarningMessage('Server is not running. Cannot download model.')
      return
    }

    const client = this.serverManager.client
    // It is actually continuing a previous download if it was incomplete.
    // Re-pulling a known-incomplete model: drop its stale "incomplete" marker
    // while it's actively downloading; it will be re-marked if it fails again.
    this.treeViewProvider.clearPartial(modelId)

    // Show a live "Downloading Models" entry in the tree view for this model.
    this.treeViewProvider.beginDownload(modelId)

    const abortController = new AbortController()
    this._activeAborts.set(modelId, abortController)

    // Stall watchdog: if the server stops sending pull events for 10 seconds,
    // abort the request so the download fails cleanly instead of hanging.
    const DOWNLOAD_STALL_TIMEOUT_MS = 10000
    let stallTimer: ReturnType<typeof setTimeout> | undefined
    let stalled = false
    const resetStallTimer = (): void => {
      if (stallTimer) clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        stalled = true
        Logger.warn(`Download stalled: no progress event for ${DOWNLOAD_STALL_TIMEOUT_MS / 1000}s, aborting ${modelId}`)
        abortController.abort()
      }, DOWNLOAD_STALL_TIMEOUT_MS)
    }
    const clearStallTimer = (): void => {
      if (stallTimer) {
        clearTimeout(stallTimer)
        stallTimer = undefined
      }
    }

    await window.withProgress(
      {
        location: ProgressLocation.Notification,
        title: `Pulling model: ${modelId}`,
        cancellable: true
      },
      async (progress, token) => {
        // Cancel the underlying HTTP request when the user dismisses the popup.
        token.onCancellationRequested(() => abortController.abort())
        let lastReportedPct = 0
        // Diagnostics: how often the server actually reports progress, and
        // whether it sends byte counts (which the tree row can display).
        let progressEvents = 0
        let sawByteCounts = false
        const startedAt = Date.now()

        resetStallTimer()
        try {
          await client.pullModelStream(
            modelId,
            (p) => {
              // Any event (even bare status) proves the stream is alive.
              resetStallTimer()
              // console.log(`Received progress update for model ${modelId}:`, p)
              progressEvents++
              if (typeof p.written === 'number' && typeof p.total === 'number') sawByteCounts = true
              const hasBytes = typeof p.written === 'number' && typeof p.total === 'number'
              if (p.pct >= 0) {
                // Calculate increment for the progress bar
                const increment = p.pct - lastReportedPct
                lastReportedPct = p.pct
                // console.log(`Progress for model ${modelId}: ${p.pct}%`)
                progress.report({
                  message: `${Math.round(p.pct)}%${p.message ? ' - ' + p.message : ''}`,
                  increment: Math.max(0, increment)
                })
              } else if (hasBytes) {
                // Byte counts without a percent: still real progress, no message.
                progress.report({})
              } else {
                // Bare status-only event (e.g. `{"status":"process"}`) with no
                // numbers: skip the popup update, matching the tree view.
                return
              }
              this.treeViewProvider.updateDowProgress(modelId, p.pct, p.message, p.written, p.total)
            },
            abortController.signal
          )
          clearStallTimer()
          this.treeViewProvider.clearPartial(modelId)
          this.treeViewProvider.endDownload(modelId)
          // The model is now downloaded, so re-query the server so it shows up
          // under Installed Models and leaves the Downloadable list.
          this.treeViewProvider.refreshServer()
          const seconds = (Date.now() - startedAt) / 1000
          const rate = seconds > 0 ? (progressEvents / seconds).toFixed(1) : '?'
          Logger.info(
            `Pulled '${modelId}': ${progressEvents} progress event(s) in ${seconds.toFixed(1)}s ` +
            `(~${rate}/s), byte counts reported: ${sawByteCounts ? 'yes' : 'no'}`
          )
          showInformationMessage(`Model '${modelId}' pulled successfully`)
        } catch (err: unknown) {
          clearStallTimer()
          // Remove from the live list, then keep it as an incomplete download.
          this.treeViewProvider.endDownload(modelId)
          if (stalled) {
            Logger.warn(`Model download stalled (no events for 10s): ${modelId}`)
            this.treeViewProvider.markPartial(modelId, lastReportedPct, 'stalled: no progress for 10s')
            this.treeViewProvider.refresh()
            showErrorMessage(`Download of '${modelId}' stalled: no progress for 10 seconds. Retry to resume.`)
          } else if (token.isCancellationRequested || abortController.signal.aborted) {
            Logger.warn(`Model download cancelled: ${modelId}`)
            this.treeViewProvider.markPartial(modelId, lastReportedPct)
            this.treeViewProvider.refresh()
            showInformationMessage(`Cancelled pulling '${modelId}'.`)
          } else {
            Logger.error('Failed to pull model', err)
            this.treeViewProvider.markPartial(modelId, lastReportedPct)
            this.treeViewProvider.refresh()
            showErrorMessage(`Failed to pull model: ${err}`)
          }
        }
      }
    )
    // The download has ended (success, cancel, stall, or error) either way.
    this._activeAborts.delete(modelId)
  }

  private _activeAborts = new Map<string, AbortController>()

  /**
   * Cancel an in-progress download (inline tree button). Aborts the pull
   * stream, which routes through the same failure path as a user cancel and
   * leaves the model under Incomplete with a Retry action.
   */
  async cancelDownload(modelId: string): Promise<void> {
    const abort = this._activeAborts.get(modelId)
    if (!abort) {
      showWarningMessage(`No active download for '${modelId}'.`)
      return
    }
    abort.abort()
  }
}
