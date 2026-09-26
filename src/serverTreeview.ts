import {
  Disposable,
  EventEmitter,
  ExtensionContext,
  ThemeColor,
  ThemeIcon,
  TreeDataProvider,
  TreeItem,
  TreeItemCollapsibleState,
  window
} from 'vscode'
const { Collapsed, Expanded, None } = TreeItemCollapsibleState

import { formatByteProgress, formatSize, getCapIcon, getServerStatusChar } from './utils'
import { Logger } from './logger'
import { ModelDecorationProvider } from './modelDecorations'
import { ModelManager } from './modelManager'
import { refreshEvents } from './events'
import { ServerManager } from './serverManager'
import { ServerMode, ServerStatus } from './interfaces'

import type {
  DownloadProgress,
  LemonadeModel,
  ServerInstance,
  SystemInfoBackend,
  SystemInfoResponse
} from './interfaces'


/** Capability grouping order and display titles for the tree view. */
const CAPABILITY_ORDER = ['llm', 'embedding', 'reranking', 'classification', 'transcription', 'tts', 'image', '3d']

const CAPABILITY_TITLES: Readonly<Record<string, string>> = {
  llm: 'LLM / Chat',
  embedding: 'Embedding',
  reranking: 'Reranking',
  classification: 'Classification',
  transcription: 'Transcription',
  tts: 'Text-to-Speech',
  image: 'Image',
  '3d': '3D',
  other: 'Other'
}

/** Storage key used to persist incomplete downloads across sessions. */
const PARTIALS_STORAGE_KEY = 'partialDownloads'

/** Storage key for the models-grouped-by-capability toggle. */
const GROUP_MODELS_KEY = 'groupModelsByCapability'

/** Storage key for the downloadable-models grouped-by-capability toggle. */
const GROUP_DOWNLOADABLE_MODELS_KEY = 'groupDownloadableModelsByCapability'

/** Storage key for the show-hot-models-only toggle (downloadable section). */
const SHOW_HOT_ONLY_KEY = 'showHotOnly'

/** Minimum gap (ms) between two repaints of the same download row. */
const DOWNLOAD_ROW_REFRESH_MS = 250

/**
 * Tree data provider for the Servers view.
 * Shows both the Lemonade Server (System) and the lemond (Managed by Chanh) in a single tree.
 */
export class ServerViewProvider implements TreeDataProvider<TreeItem>, Disposable {
  /**
   * Singleton-style factory, mirroring `LemonadeTreeDataProvider.createOrGet()`
   * from the vscode-audio-lab extension.
   */
  static async createOrGet(context: ExtensionContext, serverManager: ServerManager) {
    const provider = new ServerViewProvider(context, serverManager)
    const treeView = window.createTreeView('CHANH_TREEVIEW', {
      treeDataProvider: provider,
      showCollapseAll: true
    })
    context.subscriptions.push(treeView)
    refreshEvents.fire()
    return provider
  }

  private _onDidChangeTreeData = new EventEmitter<TreeItem | undefined | void>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  private _activeServer: ServerInstance | null = null
  /**
   * Whether the cached `_activeServer` snapshot is out of date. Set by
   * `refreshServer` when server-side state may have changed and cleared once a
   * fetch completes. Keeping the snapshot lets view-only refreshes (such as the
   * per-percent download ticks) repaint without re-querying the server.
   */
  private _serverDataStale = true

  /** In-progress model downloads, keyed by model id. */
  private _downloads = new Map<string, DownloadProgress>()
  /**
   * One stable row `TreeItem` per active download. VS Code matches a
   * `fire(element)` refresh to the exact object instance previously returned
   * from `getChildren`, so these cached instances (never fresh `new TreeItem`s)
   * are what make refreshing a single progress row possible.
   */
  private _downloadRows = new Map<string, TreeItem & { modelId: string }>()
  /** Last repaint time per download row, used to throttle progress repaints. */
  private _downloadRowRefreshedAt = new Map<string, number>()
  /** Pending trailing repaint per download row, if any. */
  private _downloadRowTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** Partial (incomplete) downloads, keyed by model id. */
  private _partials = new Map<string, DownloadProgress>()

  /**
   * Stable tree node for the "Downloading Models" section. Reusing one instance
   * keeps the node's identity stable across repaints; the count lives in
   * `description` so the label never changes.
   */
  private readonly _downloadsHeader = new TreeItem('Downloading Models', Expanded)

  /** Whether installed models are grouped by capability. */
  private _groupInsModels = false
  /** Whether downloadable catalog models are grouped by capability. */
  private _groupDowModels = false
  /** Whether the downloadable section shows only hot models. */
  private _showHotOnly = false

  /**
   * Cached `/v1/system-info` report, used to list the server's backends. This
   * response is large (tens of KB) and changes only when a backend is
   * installed, so it is fetched once per session and reused rather than
   * re-queried on every repaint like the model snapshot.
   */
  private _systemInfo: SystemInfoResponse | undefined
  private _systemInfoStale = true

  private readonly _subscriptions: Disposable[] = []

  constructor(private context: ExtensionContext, private serverManager: ServerManager) {
    // Explicit, stable ids decouple node identity from labels/descriptions so
    // text updates (counts, percentages) can never break the refresh mapping.
    this._downloadsHeader.id = 'chanh:downloads'
    this._downloadsHeader.iconPath = new ThemeIcon('cloud-download', new ThemeColor('charts.blue'))
    this._downloadsHeader.contextValue = 'CHANH_DOWNLOADING_HEADER'

    // Server-level events are rare and can change server-side state, so re-query
    // before repainting. Per-percent download ticks instead use the cached
    // snapshot, so they never hit the server.
    this._subscriptions.push(
      refreshEvents.onDidRequestRefresh(() => this.refreshServer()),
      serverManager.onStatusChange(() => this.refreshServer())
    )

    // Restore any incomplete downloads saved from a previous session.
    const saved = this.context.workspaceState.get<Array<[string, number]>>(PARTIALS_STORAGE_KEY, [])
    for (const [modelId, pct] of saved) {
      const message = pct >= 0 ? `${Math.round(pct)}% downloaded` : 'download incomplete'
      this._partials.set(modelId, { modelId, pct, message })
    }

    this._groupInsModels = this.context.workspaceState.get<boolean>(GROUP_MODELS_KEY, false)
    this._groupDowModels = this.context.workspaceState.get<boolean>(GROUP_DOWNLOADABLE_MODELS_KEY, false)
    this._showHotOnly = this.context.workspaceState.get<boolean>(SHOW_HOT_ONLY_KEY, false)
  }

  /** Flip the group-models-by-capability toggle, persist it, and refresh. */
  toggleModelGrouping(): void {
    this._groupInsModels = !this._groupInsModels
    void this.context.workspaceState.update(GROUP_MODELS_KEY, this._groupInsModels)
    this.refresh()
  }

  /** Flip the group-downloadable-models-by-capability toggle, persist it, and refresh. */
  toggleDlModelGrouping(): void {
    this._groupDowModels = !this._groupDowModels
    void this.context.workspaceState.update(GROUP_DOWNLOADABLE_MODELS_KEY, this._groupDowModels)
    this.refresh()
  }

  /** Flip the show-hot-models-only toggle (downloadable section), persist it, and refresh. */
  toggleHotModels(): void {
    this._showHotOnly = !this._showHotOnly
    void this.context.workspaceState.update(SHOW_HOT_ONLY_KEY, this._showHotOnly)
    this.refresh()
  }

  /**
   * Repaint the view from the cached server snapshot. Cheap enough to call
   * freely, but use `refreshServer` after anything that changes server state.
   */
  refresh(): void {
    this._onDidChangeTreeData.fire()
  }

  /**
   * Invalidate the cached server snapshot and repaint. Call this after any
   * action that changes server-side state (load/unload/delete/pull/config) so
   * the next `getChildren` re-queries `/v1/health` and `/v1/models`.
   */
  refreshServer(): void {
    this._serverDataStale = true
    // Backends change only when one is installed, so the report is re-fetched
    // on the same server-state invalidation to keep the section count honest.
    this._systemInfoStale = true
    this.refresh()
  }

  /** Record a model that just started downloading. */
  beginDownload(modelId: string): void {
    this._downloads.set(modelId, { modelId, pct: 0, message: 'Starting download...' })
    this._downloadRows.delete(modelId)
    this._downloadRowRefreshedAt.delete(modelId)
    this.clearDownloadRowTimer(modelId)
    // The section appears and its count changes, so the parent must re-render.
    this.refresh()
  }

  /**
   * Update live download progress and repaint just that model's row, throttled
   * to at most one repaint per `DOWNLOAD_ROW_REFRESH_MS`. A rapid burst of
   * server events coalesces into one repaint showing the latest values, plus a
   * trailing repaint so the final state is always painted. Bare status-only
   * events (no percent, no byte counts — e.g. `{"status":"process"}`) carry no
   * new information, so they are skipped entirely and the row keeps showing
   * its last numeric text. When the row is not on screen yet (first tick,
   * before the section has been expanded), fall back to the section header so
   * the row appears; subsequent ticks then hit the row directly.
   */
  updateDowProgress(modelId: string, pct: number, message: string, written?: number, total?: number): void {
    const current = this._downloads.get(modelId)
    if (!current) return
    const hasBytes = typeof written === 'number' && typeof total === 'number'
    if (pct < 0 && !hasBytes) return
    this._downloads.set(modelId, { modelId, pct, written, total, message })
    const row = this._downloadRows.get(modelId)
    if (!row) {
      this._downloadsHeader.description = `(${this._downloads.size + this._partials.size})`
      this._onDidChangeTreeData.fire(this._downloadsHeader)
      return
    }
    const now = Date.now()
    const last = this._downloadRowRefreshedAt.get(modelId) ?? 0
    if (now - last >= DOWNLOAD_ROW_REFRESH_MS) {
      this.clearDownloadRowTimer(modelId)
      this._downloadRowRefreshedAt.set(modelId, now)
      this.applyDownloadProgress(row, { modelId, pct, written, total, message })
      this._onDidChangeTreeData.fire(row)
      return
    }
    // Too soon: schedule a trailing repaint with the latest values instead.
    if (this._downloadRowTimers.has(modelId)) return
    const wait = DOWNLOAD_ROW_REFRESH_MS - (now - last)
    this._downloadRowTimers.set(
      modelId,
      setTimeout(() => {
        this._downloadRowTimers.delete(modelId)
        if (!this._downloads.has(modelId)) return
        const latest = this._downloads.get(modelId)!
        const latestRow = this._downloadRows.get(modelId)
        if (!latestRow) return
        this._downloadRowRefreshedAt.set(modelId, Date.now())
        this.applyDownloadProgress(latestRow, latest)
        this._onDidChangeTreeData.fire(latestRow)
      }, wait)
    )
  }

  /** Remove a model from the active downloads (completed or failed). */
  endDownload(modelId: string): void {
    this._downloadRows.delete(modelId)
    this._downloadRowRefreshedAt.delete(modelId)
    this.clearDownloadRowTimer(modelId)
    if (this._downloads.delete(modelId)) this.refresh()
  }

  dispose(): void {
    while (this._subscriptions.length > 0) this._subscriptions.pop()?.dispose()
    for (const timer of this._downloadRowTimers.values()) clearTimeout(timer)
    this._downloadRowTimers.clear()
    this._onDidChangeTreeData.dispose()
  }

  /** Drop any pending trailing repaint for a download row. */
  private clearDownloadRowTimer(modelId: string): void {
    const timer = this._downloadRowTimers.get(modelId)
    if (timer === undefined) return
    clearTimeout(timer)
    this._downloadRowTimers.delete(modelId)
  }

  /**
   * Mark a cancelled/failed download as incomplete so it persists under the
   * downloads group for the user to Retry or Remove. `reason` (optional)
   * explains why it ended up incomplete and is shown in the row's subtext.
   */
  markPartial(modelId: string, pct: number, reason?: string): void {
    const progress = pct >= 0 ? `${Math.round(pct)}% downloaded` : ''
    this._partials.set(modelId, {
      modelId,
      pct,
      message: [progress, reason ?? 'incomplete'].filter(Boolean).join(' - ')
    })
    this.persistPartials()
    this.refresh()
  }

  /** Forget an incomplete download (e.g. after a successful re-pull or remove). */
  clearPartial(modelId: string): void {
    if (!this._partials.delete(modelId)) return
    this.persistPartials()
    this.refresh()
  }

  /** Persist the current incomplete downloads so they survive a reload. */
  private async persistPartials(): Promise<void> {
    const entries: Array<[string, number]> = []
    for (const [modelId, partial] of this._partials) entries.push([modelId, partial.pct])
    await this.context.workspaceState.update(PARTIALS_STORAGE_KEY, entries)
  }

  getTreeItem(element: TreeItem): TreeItem {
    return element
  }

  /** Get children of the given element (or root if undefined). */
  async getChildren(element?: TreeItem): Promise<TreeItem[]> {
    if (element) {
      // Backends need an async /v1/system-info fetch, so they are resolved here
      // rather than in the synchronous getChildrenForElement dispatch.
      if (element.contextValue === 'CHANH_BACKENDS_HEADER') return this.getBackendChildren()
      return this.getChildrenForElement(element)
    }
    // Root level - fetch fresh data
    const items: TreeItem[] = []

    await this.fetchServerData()

    // The tree shows only the currently selected target server.
    const displayServer = this._activeServer
    const displayName = displayServer?.name ?? 'No server configured'
    const displayUrl = displayServer?.url ?? ''

    // Show single active server
    const serverHeader = new TreeItem(displayName, Expanded)
    serverHeader.iconPath = new ThemeIcon('server')
    serverHeader.contextValue = 'CHANH_SERVER_HEADER'
    serverHeader.tooltip = `Active server: ${displayName}\nURL: ${displayUrl}`
    items.push(serverHeader)

    // Loaded models section
    if (this._activeServer?.status === ServerStatus.RUNNING) {
      const loadedModels = this._activeServer?.health?.all_models_loaded || []

      const loadedHeader = new TreeItem(`Loaded Models (${loadedModels.length})`, Expanded)
      let color
      if (loadedModels.length) color = new ThemeColor('charts.yellow')
      loadedHeader.iconPath = new ThemeIcon('zap', color)
      loadedHeader.contextValue = 'CHANH_LOADED_HEADER'
      items.push(loadedHeader)
    }

    // Downloading models section - shows in-progress pulls followed by
    // incomplete (cancelled/failed) ones in the same group, so the user sees
    // everything pending in one place. Returns the stable `_downloadsHeader`
    // instance so refreshes reconcile without identity churn; the combined
    // count lives in `description` so the label never changes.
    const pendingCount = this._downloads.size + this._partials.size
    if (pendingCount > 0) {
      this._downloadsHeader.description = `(${pendingCount})`
      items.push(this._downloadsHeader)
    }


    // Installed models section
    if (this._activeServer?.models) {
      const models = this._activeServer.models
      const modelsHeader = new TreeItem(`Installed Models (${models.length})`, Expanded)
      modelsHeader.iconPath = new ThemeIcon('list-tree')
      modelsHeader.contextValue = 'CHANH_INSTALLED_HEADER'

      // Total size of every installed model, summed from the sizes the server
      // reports. Models without a reported size are skipped, so the tooltip
      // calls out how many models the total actually covers.
      const sized = models.filter((m) => (m.size ?? 0) > 0)
      const totalSizeText = formatSize(sized.reduce((sum, m) => sum + (m.size ?? 0), 0))
      const coverage = sized.length < models.length ? ` (${sized.length} of ${models.length} models)` : ''
      const tooltip = `${models.length} model(s) installed\n`
      const sizeTip = totalSizeText ? `Total size${coverage}: ${totalSizeText}` : `Total size: unknown`
      modelsHeader.tooltip = `${tooltip}${sizeTip}`
      items.push(modelsHeader)
    }

    // Downloadable (not-yet-downloaded catalog) models section
    if (this._activeServer?.downloadableModels) {
      const dlModels = this._activeServer.downloadableModels
      const dlCount = this._showHotOnly
        ? dlModels.filter((m) => ModelManager.isHotModel(m)).length
        : dlModels.length
      const dlHeader = new TreeItem(`Downloadable Models (${dlCount})`, Expanded)
      dlHeader.iconPath = this._showHotOnly
        ? new ThemeIcon('flame', new ThemeColor('charts.yellow'))
        : new ThemeIcon('cloud-download')
      dlHeader.contextValue = 'CHANH_DOWNLOADABLE_HEADER'
      items.push(dlHeader)
    }
    return items
  }

  /**
   * Fetch `/v1/system-info` once and cache it. Older servers may not implement
   * the endpoint, so failures degrade to an empty list rather than breaking the
   * rest of the view.
   */
  private async fetchSystemInfo(): Promise<SystemInfoResponse> {
    if (!this._systemInfoStale && this._systemInfo) return this._systemInfo
    try {
      this._systemInfo = await this.serverManager.client.getSystemInfo()
    } catch (err) {
      Logger.warn(`Could not read system info for backends: ${err}`)
      this._systemInfo = undefined
    }
    this._systemInfoStale = false
    return this._systemInfo ?? {}
  }

  /**
   * The accelerator a recipe resolves to. The pinned backend from
   * `/internal/config` wins when set; otherwise this is the `auto` default the
   * server reports in `/v1/system-info`.
   */
  private effectiveBackendFor(recipe?: string): string | undefined {
    if (!recipe) return undefined
    const data = this._systemInfo?.recipes?.[recipe]
    // Confirm the server reports at least one usable backend before naming it.
    const usable = Object.values(data?.backends ?? {}).filter((b) => b.state !== 'unsupported')
    if (usable.length === 0) return undefined
    const pinned = this._pinnedBackends.get(recipe)
    if (pinned) return pinned
    return data?.default_backend ? `auto (${data.default_backend})` : undefined
  }

  /**
   * Backend values pinned via `/internal/config`, read once per session. The
   * tree view cannot await on repaint, so this is filled in by
   * `fetchPinnedBackends()` alongside the model snapshot.
   */
  private readonly _pinnedBackends = new Map<string, string>()

  /** Read `recipe.backend` for every recipe that has one pinned off `auto`. */
  private async fetchPinnedBackends(): Promise<void> {
    this._pinnedBackends.clear()
    try {
      const config = await this.serverManager.client.getConfig()
      for (const [recipe, section] of Object.entries(config)) {
        if (!section || typeof section !== 'object') continue
        const backend = (section as Record<string, unknown>).backend
        if (typeof backend === 'string' && backend !== 'auto') this._pinnedBackends.set(recipe, backend)
      }
    } catch (err) {
      // Older servers may not expose /internal/config; tooltips then fall back
      // to the auto default.
      Logger.warn(`Could not read pinned backends: ${err}`)
    }
  }

  /** Number of backends this server can use: installed plus installable. */
  private countBackends(): number {
    return this.collectBackends(this._systemInfo ?? {}).length
  }

  /**
   * Every backend the server reports as usable, each tagged with its state.
   * `unsupported` entries are dropped: they are capability reporting (e.g. rocm
   * on a non-AMD GPU), not something the user can act on.
   */
  /** One usable backend row: the recipe it belongs to, its name, and its state. */
  private collectBackends(
    info: SystemInfoResponse
  ): Array<{ recipe: string, name: string, backend: SystemInfoBackend }> {
    return Object.entries(info.recipes ?? {}).flatMap(([recipe, data]) =>
      Object.entries(data.backends ?? {})
        .filter(([, backend]) => backend.state !== 'unsupported')
        .map(([name, backend]) => ({ recipe, name, backend }))
    )
  }

  /**
   * One row per usable backend (installed or installable), grouped under a
   * collapsible header per recipe. `unsupported` entries are filtered out in
   * `collectBackends()`; they describe hardware this machine does not have.
   */
  private async getBackendChildren(): Promise<TreeItem[]> {
    const info = await this.fetchSystemInfo()
    // Group the usable backends by recipe, keeping each recipe's own metadata
    // for the collapsible header.
    type BackendGroup = {
      displayName?: string
      modality?: string
      selectable?: boolean
      backends: Array<{ name: string, backend: SystemInfoBackend }>
    }
    const grouped = new Map<string, BackendGroup>()
    for (const { recipe, name, backend } of this.collectBackends(info)) {
      const data = info.recipes?.[recipe]
      const group = grouped.get(recipe) ?? {
        displayName: data?.display_name,
        modality: data?.modality,
        selectable: data?.selectable_backend,
        backends: []
      }
      group.backends.push({ name, backend })
      grouped.set(recipe, group)
    }
    const entries = [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))

    if (entries.length === 0) {
      const empty = new TreeItem('No backends available', None)
      empty.iconPath = new ThemeIcon('circle-slash')
      return [empty]
    }

    return entries.map(([recipe, group]) => {
      const title = group.displayName ?? recipe
      const header = new TreeItem(`${title} (${group.backends.length})`, Expanded)
      header.iconPath = new ThemeIcon('package')
      header.contextValue = 'CHANH_BACKEND_RECIPE'
      header.description = recipe
      header.tooltip = `Recipe: ${recipe}` +
        (group.modality ? `\nModality: ${group.modality}` : '') +
        (group.selectable ? '\nBackend is selectable' : '')

      // Installed rows come first within the group so the ready-to-run backends
      // are visible without scrolling.
      const rows = [...group.backends]
        .sort((a, b) => Number(b.backend.state === 'installed') - Number(a.backend.state === 'installed'))
        .map(({ name, backend }) => this.toBackendItem(recipe, name, backend))
        ; (header as TreeItem & { backendRows?: TreeItem[] }).backendRows = rows
      return header
    })
  }

  /** Build the leaf row for one usable backend, describing its state. */
  private toBackendItem(recipe: string, name: string, backend: SystemInfoBackend): TreeItem {
    const installed = backend.state === 'installed'
    const item = new TreeItem(name, None)
    item.iconPath = installed ? new ThemeIcon('pass-filled') : new ThemeIcon('cloud-download')
    // Show the server-reported state verbatim so installed and installable rows
    // are distinguishable at a glance.
    item.description = backend.state ?? 'unknown'
    item.contextValue = installed ? 'CHANH_BACKEND_INSTALLED' : 'CHANH_BACKEND_INSTALLABLE'
    item.tooltip = [`Recipe: ${recipe}`, `State: ${backend.state ?? 'unknown'}`]
      .concat(backend.version ? [`Version: ${backend.version}`] : [])
      .concat(backend.devices?.length ? [`Devices: ${backend.devices.join(', ')}`] : [])
      .concat(backend.message ? [`Note: ${backend.message}`] : [])
      .join('\n')
    return item
  }

  private getChildrenForElement(element: TreeItem): TreeItem[] {
    if ((element as TreeItem & { backendRows?: TreeItem[] }).backendRows) {
      return (element as TreeItem & { backendRows: TreeItem[] }).backendRows
    }
    if (element.contextValue === 'CHANH_SERVER_HEADER') return this.getServerChildren(this._activeServer)
    if (element.contextValue === 'CHANH_LOADED_HEADER') return this.getLoadedModelChildren(element)
    if (element.contextValue === 'CHANH_DOWNLOADING_HEADER') return this.getDownloadingChildren()
    if (element.contextValue === 'CHANH_PINNED_HEADER') return this.getPinnedModelChildren(element)
    if (element.contextValue === 'CHANH_INSTALLED_HEADER') return this.getInstalledChildren(element)
    if (element.contextValue === 'CHANH_DOWNLOADABLE_HEADER') return this.getDownloadableChildren()
    if (element.contextValue === 'CHANH_CAP_GROUP') return this.getCapGroupChildren(element)
    return []
  }

  private getServerChildren(server: ServerInstance | null): TreeItem[] {
    if (!server) return []

    const items: TreeItem[] = []
    // Status indicator — on error, the message becomes the row's subtext
    // (description) so the user sees what's wrong next to the status.
    const { color, icon, text } = getServerStatusChar(server.status)
    const statusItem = new TreeItem(`Status: ${text}`, None)
    statusItem.iconPath = new ThemeIcon(icon, new ThemeColor(color))
    statusItem.contextValue = `CHANH_SERVER_${server.status}`
    if (server.status === ServerStatus.ERROR && server.error) {
      statusItem.description = server.error
    }
    items.push(statusItem)

    // Server URL
    const urlItem = new TreeItem(server.url, None)
    urlItem.iconPath = new ThemeIcon('link')
    urlItem.tooltip = `Server URL: ${server.url}`
    urlItem.contextValue = 'CHANH_SERVER_URL'
    items.push(urlItem)

    // Version
    if (server.version) {
      const versionItem = new TreeItem(`Version: v${server.version}`, None)
      versionItem.iconPath = new ThemeIcon('versions')
      versionItem.tooltip = 'Lemonade Server binary version'
      items.push(versionItem)
    }

    // Max loaded models
    if (server.maxLoadedModels !== undefined) {
      const maxModelsText = server.maxLoadedModels === -1 ? 'Unlimited' : String(server.maxLoadedModels)
      const maxModelsItem = new TreeItem(`Max Loaded Models: ${maxModelsText}`, None)
      maxModelsItem.iconPath = new ThemeIcon('symbol-number')
      const configLabel = server.id === ServerMode.LEMOND ? ' (configured in settings)' : ''
      maxModelsItem.tooltip = `Maximum models that can be loaded simultaneously${configLabel}`
      items.push(maxModelsItem)
    }

    // Backends section - the inference backends this server can use, grouped by
    // recipe. The count covers both installed and not-yet-installed backends,
    // since both are actionable.
    if (this._activeServer?.status === ServerStatus.RUNNING) {
      const count = this.countBackends()
      const backendsHeader = new TreeItem(`Backends (${count})`, Collapsed)
      backendsHeader.iconPath = new ThemeIcon('circuit-board')
      backendsHeader.contextValue = 'CHANH_BACKENDS_HEADER'
      backendsHeader.tooltip = `${count} backend(s) installed or installable, grouped by recipe`
      items.push(backendsHeader)
    }

    // Pinned models section
    if (this._activeServer?.status === ServerStatus.RUNNING) {
      const pinnedModels = this._activeServer?.health?.pinned_models
      const pinnedEntries = pinnedModels ? Object.entries(pinnedModels) : []
      const pinnedCount = pinnedEntries.reduce((sum, [, count]) => sum + (count ?? 0), 0)

      const pinnedHeader = new TreeItem(`Pinned Models (${pinnedCount})`, Collapsed)
      const pinnedColor = pinnedCount > 0 ? new ThemeColor('charts.blue') : undefined
      pinnedHeader.iconPath = new ThemeIcon('pin', pinnedColor)
      pinnedHeader.contextValue = 'CHANH_PINNED_HEADER'
      items.push(pinnedHeader)
    }

    return items
  }

  private getLoadedModelChildren(element: TreeItem): TreeItem[] {
    const server = this._activeServer
    if (!server?.health) return []
    const loadedModels = server.health.all_models_loaded

    if (!loadedModels || loadedModels.length === 0) {
      const noModelsItem = new TreeItem('No loaded models', None)
      noModelsItem.iconPath = new ThemeIcon('circle-slash')
      return [noModelsItem]
    }

    return loadedModels.map((model) => {
      const item = new TreeItem(model.model_name, None)
      item.iconPath = new ThemeIcon('pass-filled', new ThemeColor('charts.green'))
      // Enrich the runtime status with the downloaded model's catalog metadata
      // (size, context, recipe...) when the model is in the server's model list.
      const catalogModel = server.models?.find((m) => m.id === model.model_name)
      if (catalogModel) {
        item.tooltip = this.buildModelTooltip(catalogModel, {
          isLoaded: true,
          busy: model.is_busy,
          streaming: model.is_streaming,
          backendUrl: model.backend_url,
          effectiveBackend: this.effectiveBackendFor(catalogModel.recipe)
        })
      } else item.tooltip = `Model: ${model.model_name}\nBusy: ${model.is_busy}\nStreaming: ${model.is_streaming}`

      item.contextValue = 'CHANH_LOADED_MODEL'
      item.description = model.is_busy ? 'busy' : 'idle'
      return item
    })
  }

  private getDownloadingChildren(): TreeItem[] {
    const items: TreeItem[] = []
    for (const download of this._downloads.values()) {
      // Reuse the cached row instance: VS Code can only refresh an element it
      // already knows by object identity, so returning a fresh `new TreeItem`
      // here would make `fire(row)` a no-op for this row.
      let item = this._downloadRows.get(download.modelId)
      if (!item) {
        item = new TreeItem(download.modelId, None) as TreeItem & { modelId: string }
        // Stable identity keeps this row (and its spinner) as the same node across
        // frequent progress repaints instead of being torn down and rebuilt.
        item.id = `download:${download.modelId}`
        item.iconPath = new ThemeIcon('loading~spin', new ThemeColor('charts.blue'))
        item.contextValue = 'CHANH_DOWNLOADING_MODEL'
        // Commands (e.g. the inline cancel button) receive this item as the
        // argument, so it must carry the model id.
        item.modelId = download.modelId
        // Inline cancel button so the user can abort the pull from the row.
        // (Cast needed: the trimmed @types/vscode here omits TreeItem.buttons,
        // but the runtime API supports it.)
        ; (item as TreeItem & { buttons?: Array<{ command: string, tooltip?: string }> }).buttons = [
          { command: 'chanh.cancelDownload', tooltip: 'Cancel download' }
        ]
        this._downloadRows.set(download.modelId, item)
      }
      this.applyDownloadProgress(item, download)
      items.push(item)
    }
    // Incomplete (cancelled/failed) downloads render in the same group, after
    // the active ones, so everything pending is visible in one place.
    items.push(...this.getPartialDownloadChildren())
    return items
  }

  /** Render the latest progress state onto a cached download row in place. */
  private applyDownloadProgress(item: TreeItem, download: DownloadProgress): void {
    item.tooltip = download.message ? `${download.modelId}\n${download.message}` : download.modelId
    console.log(`Applying download progress for model ${download.modelId}:`, download)
    const subtextParts: string[] = []
    const hasBytes = typeof download.written === 'number' && typeof download.total === 'number'
    // One decimal so the percentage visibly advances on every repaint; a whole
    // number only changes ~100 times across the entire download.
    if (download.pct >= 0) subtextParts.push(`${download.pct.toFixed(1)}%`)
    if (hasBytes) {
      subtextParts.push(formatByteProgress(download.written!, download.total!))
    }
    item.description = subtextParts.length > 0 ? subtextParts.join('  ') : download.message
  }

  private getPartialDownloadChildren(): TreeItem[] {
    const items: TreeItem[] = []
    for (const partial of this._partials.values()) {
      const item = new TreeItem(partial.modelId, None) as TreeItem & { modelId: string }
      item.modelId = partial.modelId
      item.iconPath = new ThemeIcon('warning', new ThemeColor('charts.yellow'))
      item.contextValue = 'CHANH_PARTIAL_MODEL'
      item.description = partial.message || 'incomplete'
      item.tooltip = `${partial.modelId}\nNot fully downloaded. Retry, or Remove to delete the partial file.`
      items.push(item)
    }
    return items
  }

  private getPinnedModelChildren(element: TreeItem): TreeItem[] {
    const server = this._activeServer
    const pinned = server?.health?.pinned_models
    if (!pinned) return []

    const entries = Object.entries(pinned)
    if (entries.length === 0) {
      const noItem = new TreeItem('No pinned models', None)
      noItem.iconPath = new ThemeIcon('circle-slash', new ThemeColor('charts.gray'))
      return [noItem]
    }

    return entries.map(([category, count]) => {
      const value = count ?? 0
      const item = new TreeItem(category, None)
      item.description = String(value)
      const color = value > 0 ? new ThemeColor('charts.green') : new ThemeColor('charts.gray')
      item.iconPath = new ThemeIcon('pinned', color)
      item.tooltip = `${category}: ${value} pinned`
      return item
    })
  }

  private getInstalledChildren(element: TreeItem): TreeItem[] {
    const server = this._activeServer
    if (!server?.models) return []

    if (server.models.length === 0) {
      const noModelsItem = new TreeItem('No models downloaded yet.', None)
      noModelsItem.iconPath = new ThemeIcon('circle-filled')
      return [noModelsItem]
    }

    if (this._groupInsModels) return this.getCapabilityGroups(server.models)

    const loadedIds = new Set(server.health?.all_models_loaded.map((m) => m.model_name) ?? [])
    const orderedModels = this.sortModelsLoadedFirst(server.models, loadedIds)
    return orderedModels.map((model) => this.toAvaModelItem(model, loadedIds.has(model.id)))
  }

  /** Downloadable catalog models (not yet on disk) — each pulls on click. */
  private getDownloadableChildren(): TreeItem[] {
    const models = this._activeServer?.downloadableModels ?? []
    const displayModels = this._showHotOnly ? models.filter((m) => ModelManager.isHotModel(m)) : models
    if (displayModels.length === 0) {
      const none = new TreeItem('No downloadable models available.', None)
      none.iconPath = new ThemeIcon('check')
      return [none]
    }
    if (this._groupDowModels) return this.getCapabilityGroups(displayModels, true)
    return displayModels.map((model) => this.toDowItem(model))
  }

  /**
   * Build a detailed multi-line tooltip for a model, appending all
   * server-reported metadata (capabilities, size, context length, recipe,
   * ownership, add date, runtime status, upstream updates) below the model id.
   */
  private buildModelTooltip(
    model: LemonadeModel,
    opts: {
      isDownloadable?: boolean
      isLoaded?: boolean
      busy?: boolean
      streaming?: boolean
      /** Per-model runtime endpoint from `/v1/health` (loaded models only). */
      backendUrl?: string
      /** Accelerator the recipe resolves to, e.g. `cuda` (from system-info). */
      effectiveBackend?: string
    } = {}
  ): string {
    const lines: string[] = [model.id]

    const label = ModelManager.getModelLabel(model)
    if (label) lines.push(`Capabilities: ${label}`)

    const sizeText = formatSize(model.size)
    if (sizeText) lines.push(`Size: ${sizeText}`)

    if (typeof model.context_length === 'number' && model.context_length > 0) {
      lines.push(`Context: ${model.context_length.toLocaleString()} tokens`)
    }

    if (model.recipe) lines.push(`Recipe: ${model.recipe}`)
    if (model.type) lines.push(`Type: ${model.type}`)
    if (model.owned_by) lines.push(`Owned By: ${model.owned_by}`)

    // if (typeof model.created === 'number' && model.created > 0)
    //   lines.push(`Added: ${new Date(model.created * 1000).toISOString().slice(0, 10)}`)

    // if (opts.isLoaded) {
    //   const status = ['loaded']
    //   if (opts.busy) status.push('busy')
    //   if (opts.streaming) status.push('streaming')
    //   lines.push(`Status: ${status.join(', ')}`)
    // } else if (opts.isDownloadable)
    //   lines.push('Status: not downloaded — pull to install')
    // else
    //   lines.push('Status: downloaded — load to use')


    // Backend: the accelerator the recipe resolves to (from system-info), plus
    // the per-model runtime endpoint once the model is loaded.
    if (opts.effectiveBackend) lines.push(`Backend: ${opts.effectiveBackend}`)
    if (opts.backendUrl) lines.push(`Endpoint: ${opts.backendUrl}`)
    if (model.update_available) lines.push('⚠ Update available upstream — pull again to update')

    return lines.join('\n')
  }

  /** Build one downloadable-model leaf row with a pull affordance. */
  private toDowItem(model: LemonadeModel): TreeItem {
    const item = new TreeItem(model.id, None) as TreeItem & { modelId: string }
    item.modelId = model.id
    const sizeText = formatSize(model.size)
    if (sizeText) item.description = sizeText
    // Hot models get the flame icon so the user can spot them at a glance;
    // non-hot downloadable models keep the cloud-download icon.
    const isHot = ModelManager.isHotModel(model)
    item.iconPath = isHot ? getCapIcon(this.context.extensionUri, 'hot') : new ThemeIcon('circle-filled')

    let tooltip = this.buildModelTooltip(model, { isDownloadable: true })
    if (isHot) tooltip = `🔥 ${tooltip}`

    item.tooltip = tooltip
    item.contextValue = 'CHANH_DOWNLOADABLE_MODEL'
    return item
  }

  /** Build one installed-model leaf row (shared by flat and grouped modes). */
  private toAvaModelItem(model: LemonadeModel, isLoaded: boolean, showHotFlame = false): TreeItem {
    const item = new TreeItem(model.id, None) as TreeItem & { modelId: string }
    item.modelId = model.id

    // Loaded models get a green label via the FileDecoration provider
    // (the tree-item API has no direct way to color label text).
    item.resourceUri = ModelDecorationProvider.uriFor(model.id, isLoaded)

    // Subtext: size only (the capability label is not listed here anymore)
    const sizeText = formatSize(model.size)
    if (sizeText) item.description = sizeText

    const isHot = ModelManager.isHotModel(model)

    // Tooltip: append the model's server-reported metadata; loaded models also
    // report their runtime state (busy/streaming/backend).
    const loadedEntry = isLoaded
      ? this._activeServer?.health?.all_models_loaded.find((m) => m.model_name === model.id)
      : undefined
    const tooltip = this.buildModelTooltip(model, {
      isLoaded,
      busy: loadedEntry?.is_busy,
      streaming: loadedEntry?.is_streaming,
      backendUrl: loadedEntry?.backend_url,
      effectiveBackend: this.effectiveBackendFor(model.recipe)
    })

    // Unloaded hot models wear the flame when grouped by capability; in the
    // flat list the flame is suppressed so no per-model marker is needed.
    if (showHotFlame && isHot && !isLoaded) item.iconPath = getCapIcon(this.context.extensionUri, 'hot')
    else if (isLoaded) item.iconPath = new ThemeIcon('pass-filled', new ThemeColor('charts.green'))
    else item.iconPath = new ThemeIcon('circle')

    item.tooltip = tooltip

    if (isLoaded) item.contextValue = 'CHANH_MODEL_LOADED'
    else item.contextValue = 'CHANH_MODEL_INSTALLED'
    // Rows with a saved ctx_size override get a suffix so the Reset Context
    // Size menu item can be shown only for them.
    if (model.recipe_options?.ctx_size !== undefined) item.contextValue += '_CTX_SET'
    return item
  }

  /**
   * Return a copy of `models` with loaded models sorted before unloaded ones.
   * The original array is not mutated; load order among already-loaded (or
   * among not-yet-loaded) models is preserved (stable sort).
   */
  private sortModelsLoadedFirst(models: LemonadeModel[], loadedIds: Set<string>): LemonadeModel[] {
    return [...models].sort((a, b) => {
      const aLoaded = loadedIds.has(a.id) ? 0 : 1
      const bLoaded = loadedIds.has(b.id) ? 0 : 1
      return aLoaded - bLoaded
    })
  }

  /** Group installed models under one collapsible header per capability. */
  private getCapabilityGroups(models: LemonadeModel[], downloadable = false): TreeItem[] {
    const grouped = new Map<string, LemonadeModel[]>()
    for (const model of models) {
      const categories = ModelManager.getCapabilityCategories(model)
      // A multi-capability model appears under every capability it has, so
      // nothing is hidden from a group it belongs to.
      if (categories.length === 0) categories.push('other')
      for (const category of categories) {
        const bucket = grouped.get(category) ?? []
        bucket.push(model)
        grouped.set(category, bucket)
      }
    }

    const order = [...CAPABILITY_ORDER, 'other']
    return order
      .filter((category) => grouped.has(category))
      .map((category) => {
        const bucket = grouped.get(category) ?? []
        const title = CAPABILITY_TITLES[category] ?? category
        const item = new TreeItem(`${title} (${bucket.length})`, Collapsed)
        item.contextValue = 'CHANH_CAP_GROUP'
        // TODO: Consider adding additional context or actions for capability groups.
        ; (item as TreeItem & { capability: string }).capability = category
        ; (item as TreeItem & { downloadable: boolean }).downloadable = downloadable
        item.tooltip = `${bucket.length} model(s) with ${title} capability`
        // Capability groups wear the matching colored SVG; "other" gets a dot.
        item.iconPath = getCapIcon(this.context.extensionUri, category)
        return item
      })
  }

  /** Models (installed or downloadable) under one capability group header. */
  private getCapGroupChildren(element: TreeItem): TreeItem[] {
    const capability = (element as TreeItem & { capability?: string }).capability
    const downloadable = (element as TreeItem & { downloadable?: boolean }).downloadable
    const server = this._activeServer
    if (!capability) return []

    const source = downloadable ? server?.downloadableModels : server?.models
    if (!source) return []

    // When hot-only is active, restrict downloadable models to hot ones.
    const effectiveSource = downloadable && this._showHotOnly
      ? source.filter((m) => ModelManager.isHotModel(m))
      : source

    // Multi-capability models live in every group they belong to, so the same
    // filter applies whether the source is downloaded or downloadable models.
    const filtered = effectiveSource.filter((m) => {
      const categories = ModelManager.getCapabilityCategories(m)
      if (categories.length === 0) return capability === 'other'
      return categories.includes(capability)
    })

    if (downloadable) return filtered.map((m) => this.toDowItem(m))

    const loadedIds = new Set(server?.health?.all_models_loaded.map((m) => m.model_name) ?? [])
    // Within each capability group, surface loaded models first.
    const ordered = this.sortModelsLoadedFirst(filtered, loadedIds)
    return ordered.map((m) => this.toAvaModelItem(m, loadedIds.has(m.id), true))
  }

  /**
   * Fetch server data, reusing the cached snapshot unless `refreshServer`
   * invalidated it. Avoids a `/v1/health` + `/v1/models` round-trip (and a full
   * catalog re-parse) on every repaint.
   */
  private async fetchServerData(): Promise<void> {
    if (!this._serverDataStale && this._activeServer) return
    this._activeServer = await this.serverManager.getActiveServer()
    this._serverDataStale = false
    // Warm the backend cache here so the section header count is right on the
    // first paint, and so model tooltips can name the pinned backend.
    if (this._activeServer?.status === ServerStatus.RUNNING) {
      await this.fetchSystemInfo()
      await this.fetchPinnedBackends()
    }
  }
}
