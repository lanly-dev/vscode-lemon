import * as vscode from 'vscode'

import { TreeDataProvider, TreeItem, TreeItemCollapsibleState } from 'vscode'
const { None, Expanded } = TreeItemCollapsibleState

import { ServerManager } from './serverManager'
import { ServerStatus } from './interfaces'
import { getModelLabel } from './modelLabel'

import type { DownloadProgress, ServerInstance } from './interfaces'

/** Format a byte count as a human-readable size (e.g. 1.2 GB). */
function formatBytes(value: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = value
  let unit = 0
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024
    unit++
  }
  return `${n.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

/**
 * Tree data provider for the Servers view.
 * Shows both the standalone Lemonade app and the lemon app in a single tree.
 */
export class ServerViewProvider implements TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  private _activeServer: ServerInstance | null = null

  /** In-progress model downloads, keyed by model id. */
  private _downloads = new Map<string, DownloadProgress>()

  /** Partial (incomplete) downloads, keyed by model id. */
  private _partials = new Map<string, DownloadProgress>()

  constructor(private serverManager: ServerManager) {
    serverManager.onStatusChange(() => this.refresh())
  }

  refresh(): void {
    this._onDidChangeTreeData.fire()
  }

  /** Record a model that just started downloading. */
  beginDownload(modelId: string): void {
    this._downloads.set(modelId, { modelId, pct: 0, message: 'Starting download...' })
    this.refresh()
  }

  /**
   * Update live download progress, refreshing the tree only when the progress
   * crosses a 5% step (so we don't re-render the whole tree on every event).
   */
  updateDownload(modelId: string, pct: number, message: string, written?: number, total?: number): void {
    const current = this._downloads.get(modelId)
    if (!current) return

    const bucket = pct >= 0 ? Math.floor(pct / 5) : -1
    const currentBucket = current.pct >= 0 ? Math.floor(current.pct / 5) : -1
    const shouldRefresh = bucket !== currentBucket && current.pct !== 0

    this._downloads.set(modelId, { modelId, pct, written, total, message })
    if (shouldRefresh) this.refresh()
  }

  /** Remove a model from the active downloads (completed or failed). */
  endDownload(modelId: string): void {
    if (this._downloads.delete(modelId)) this.refresh()
  }

  /**
   * Mark a cancelled/failed download as incomplete so it persists under
   * "Incomplete Downloads" for the user to Retry or Remove.
   */
  markPartial(modelId: string, pct: number): void {
    this._partials.set(modelId, {
      modelId,
      pct,
      message: pct >= 0 ? `${Math.round(pct)}% downloaded` : 'download incomplete'
    })
    this.refresh()
  }

  /** Forget an incomplete download (e.g. after a successful re-pull or remove). */
  clearPartial(modelId: string): void {
    if (this._partials.delete(modelId)) this.refresh()
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element
  }

  /** Get children of the given element (or root if undefined). */
  async getChildren(element?: TreeItem): Promise<TreeItem[]> {
    if (element) return this.getChildrenForElement(element)
    // Root level - fetch fresh data
    const items: TreeItem[] = []

    await this.fetchServerData()

    // The tree shows only the currently selected target server.
    const displayServer = this._activeServer
    const displayName = displayServer?.name ?? 'No server configured'
    const displayUrl = displayServer?.url ?? ''

    // Show single active server
    const serverHeader = new TreeItem(displayName, Expanded)
    serverHeader.iconPath = new vscode.ThemeIcon('server')
    serverHeader.contextValue = 'LEMON_SERVER_HEADER'
    serverHeader.tooltip = `Active server: ${displayName}\nURL: ${displayUrl}`
    items.push(serverHeader)

    // Loaded models section
    const loadedModels = this._activeServer?.health?.all_models_loaded || []

    const loadedHeader = new TreeItem(`Loaded Models (${loadedModels.length})`, Expanded)
    let color
    if (loadedModels.length) color = new vscode.ThemeColor('charts.yellow')
    loadedHeader.iconPath = new vscode.ThemeIcon('zap', color)
    loadedHeader.contextValue = 'LEMOND_LOADED_HEADER'
    loadedHeader.tooltip = this._activeServer?.id
    items.push(loadedHeader)

    // Downloading models section - only shown while a model is being pulled.
    if (this._downloads.size > 0) {
      const downloadingHeader = new TreeItem(`Downloading Models (${this._downloads.size})`, Expanded)
      downloadingHeader.iconPath = new vscode.ThemeIcon('cloud-download', new vscode.ThemeColor('charts.blue'))
      downloadingHeader.contextValue = 'LEMOND_DOWNLOADING_HEADER'
      downloadingHeader.tooltip = this._activeServer?.id
      items.push(downloadingHeader)
    }

    // Incomplete downloads section - leftover partial files from cancelled/failed pulls.
    if (this._partials.size > 0) {
      const partialHeader = new TreeItem(`Incomplete Downloads (${this._partials.size})`, Expanded)
      partialHeader.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'))
      partialHeader.contextValue = 'LEMOND_PARTIAL_HEADER'
      partialHeader.tooltip = this._activeServer?.id
      items.push(partialHeader)
    }


    // Available models section
    if (this._activeServer?.models && this._activeServer.models.length > 0) {
      const modelsHeader = new TreeItem(`Available Models (${this._activeServer.models.length})`, Expanded)
      modelsHeader.iconPath = new vscode.ThemeIcon('list-tree')
      modelsHeader.contextValue = 'LEMOND_MODELS_HEADER'
      modelsHeader.tooltip = this._activeServer.id
      items.push(modelsHeader)
    } else if (this._activeServer?.status === ServerStatus.RUNNING) {
      const noModels = new TreeItem('No models available', None)
      noModels.iconPath = new vscode.ThemeIcon('circle-filled')
      noModels.tooltip = 'Pull a model using the "Lemonade: Pull Model" command'
      items.push(noModels)
    }
    return items
  }

  /** Get children for a specific element. */
  private getChildrenForElement(element: TreeItem): TreeItem[] {
    if (element.contextValue === 'LEMON_SERVER_HEADER') return this.getServerChildren(this._activeServer)
    if (element.contextValue === 'LEMOND_LOADED_HEADER') return this.getLoadedModelChildren(element)
    if (element.contextValue === 'LEMOND_DOWNLOADING_HEADER') return this.getDownloadingChildren()
    if (element.contextValue === 'LEMOND_PARTIAL_HEADER') return this.getPartialDownloadChildren()
    if (element.contextValue === 'LEMOND_PINNED_HEADER') return this.getPinnedModelChildren(element)
    if (element.contextValue === 'LEMOND_MODELS_HEADER') return this.getModelChildren(element)
    return []
  }

  private getServerChildren(server: ServerInstance | null): TreeItem[] {
    if (!server) return []

    const items: vscode.TreeItem[] = []

    // Status indicator
    const statusText = this.getStatusText(server.status)
    const statusItem = new TreeItem(`Status: ${statusText}`, None)
    statusItem.iconPath = new vscode.ThemeIcon(
      this.getStatusIcon(server.status),
      new vscode.ThemeColor(this.getStatusColor(server.status))
    )
    statusItem.contextValue = `LEMON_SERVER_${server.status}`
    items.push(statusItem)

    // Server URL
    const urlItem = new TreeItem(server.url, None)
    urlItem.iconPath = new vscode.ThemeIcon('link')
    urlItem.tooltip = `Server URL: ${server.url}`
    urlItem.contextValue = 'LEMOND_SERVER_URL'
    items.push(urlItem)

    // Version
    if (server.version) {
      const versionItem = new TreeItem(`Version: v${server.version}`, None)
      versionItem.iconPath = new vscode.ThemeIcon('versions')
      versionItem.tooltip = 'Lemonade Server binary version'
      items.push(versionItem)
    }

    // Max loaded models
    if (server.maxLoadedModels !== undefined) {
      const maxModelsText = server.maxLoadedModels === -1
        ? 'Unlimited'
        : String(server.maxLoadedModels)
      const maxModelsItem = new TreeItem(`Max Loaded Models: ${maxModelsText}`, None)
      maxModelsItem.iconPath = new vscode.ThemeIcon('symbol-number')
      const configLabel = server.id === 'lemon' ? ' (configured in settings)' : ''
      maxModelsItem.tooltip = `Maximum models that can be loaded simultaneously${configLabel}`
      items.push(maxModelsItem)
    }

    // Pinned models section
    const pinnedModels = this._activeServer?.health?.pinned_models
    const pinnedEntries = pinnedModels ? Object.entries(pinnedModels) : []
    const pinnedCount = pinnedEntries.reduce((sum, [, count]) => sum + (count ?? 0), 0)

    const pinnedHeader = new TreeItem(`Pinned Models (${pinnedCount})`, Expanded)
    const pinnedColor = pinnedCount > 0 ? new vscode.ThemeColor('charts.blue') : undefined
    pinnedHeader.iconPath = new vscode.ThemeIcon('pin', pinnedColor)
    pinnedHeader.contextValue = 'LEMOND_PINNED_HEADER'
    pinnedHeader.tooltip = this._activeServer?.id
    items.push(pinnedHeader)

    // Error message if any
    if (server.error) {
      const errorItem = new TreeItem(`Error: ${server.error}`, None)
      errorItem.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'))
      items.push(errorItem)
    }
    return items
  }

  private getLoadedModelChildren(element: vscode.TreeItem): TreeItem[] {
    const server = this.findServerByTooltip(element.tooltip)
    if (!server?.health) return []
    const loadedModels = server.health.all_models_loaded

    if (!loadedModels || loadedModels.length === 0) {
      const noModelsItem = new TreeItem('No loaded models', None)
      noModelsItem.iconPath = new vscode.ThemeIcon('circle-slash')
      return [noModelsItem]
    }

    return loadedModels.map((model) => {
      const item = new TreeItem(model.model_name, None)
      item.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'))
      item.tooltip = `Model: ${model.model_name}\nBusy: ${model.is_busy}\nStreaming: ${model.is_streaming}`
      item.contextValue = 'LEMOND_LOADED_MODEL'
      item.description = model.is_busy ? 'busy' : 'idle'
      return item
    })
  }

  private getDownloadingChildren(): vscode.TreeItem[] {
    const items: vscode.TreeItem[] = []
    for (const download of this._downloads.values()) {
      const item = new TreeItem(download.modelId, None)
      item.iconPath = new vscode.ThemeIcon('loading~spin', new vscode.ThemeColor('charts.blue'))
      item.contextValue = 'LEMOND_DOWNLOADING_MODEL'
      item.tooltip = download.message ? `${download.modelId}\n${download.message}` : download.modelId

      const subtextParts: string[] = []
      if (download.pct >= 0) subtextParts.push(`${Math.round(download.pct)}%`)
      const sizeText = typeof download.written === 'number' && typeof download.total === 'number'
        ? `${formatBytes(download.written!)} / ${formatBytes(download.total!)}`
        : ''
      if (sizeText) subtextParts.push(sizeText)
      item.description = subtextParts.length > 0 ? subtextParts.join('  ') : download.message
      items.push(item)
    }
    return items
  }

  private getPartialDownloadChildren(): vscode.TreeItem[] {
    const items: vscode.TreeItem[] = []
    for (const partial of this._partials.values()) {
      const item = new TreeItem(partial.modelId, None) as vscode.TreeItem & { modelId: string }
      item.modelId = partial.modelId
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow'))
      item.contextValue = 'LEMOND_PARTIAL_MODEL'
      item.description = partial.pct >= 0 ? `${Math.round(partial.pct)}% downloaded - incomplete` : 'incomplete'
      item.tooltip = `${partial.modelId}\nNot fully downloaded. Retry, or Remove to delete the partial file.`
      items.push(item)
    }
    return items
  }

  private getPinnedModelChildren(element: vscode.TreeItem): TreeItem[] {
    const server = this.findServerByTooltip(element.tooltip)
    const pinned = server?.health?.pinned_models
    if (!pinned) return []

    const entries = Object.entries(pinned)
    if (entries.length === 0) {
      const noItem = new TreeItem('No pinned models', None)
      noItem.iconPath = new vscode.ThemeIcon('circle-slash', new vscode.ThemeColor('charts.gray'))
      return [noItem]
    }

    return entries.map(([category, count]) => {
      const value = count ?? 0
      const item = new TreeItem(category, None)
      item.description = String(value)
      const color = value > 0 ? new vscode.ThemeColor('charts.green') : new vscode.ThemeColor('charts.gray')
      item.iconPath = new vscode.ThemeIcon('pinned', color)
      item.tooltip = `${category}: ${value} pinned`
      return item
    })
  }

  private getModelChildren(element: vscode.TreeItem): vscode.TreeItem[] {
    const server = this.findServerByTooltip(element.tooltip)
    if (!server?.models) return []

    const loadedIds = new Set(server.health?.all_models_loaded.map((m) => m.model_name) ?? [])
    return server.models.map((model) => {
      const isLoaded = loadedIds.has(model.id)
      const item = new TreeItem(model.id, None) as vscode.TreeItem & { modelId: string }
      item.modelId = model.id

      // Show the model's category label (e.g. "Transcription", "Image") as subtext.
      const modelLabel = getModelLabel(model)
      if (modelLabel) item.description = modelLabel

      if (isLoaded) {
        item.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'))
        item.contextValue = 'LEMOND_MODEL_LOADED'
      } else {
        item.iconPath = new vscode.ThemeIcon('circle')
        item.tooltip = `Model: ${modelLabel ? `${model.id} (${modelLabel})` : model.id}`
        item.contextValue = 'LEMOND_MODEL_AVAILABLE'
      }
      return item
    })
  }

  /** Find a server instance by its tooltip id. */
  private findServerByTooltip(tooltip: vscode.TreeItem['tooltip']): ServerInstance | null {
    const id = typeof tooltip === 'string' ? tooltip : ''
    if (this._activeServer?.id === id) return this._activeServer
    return null
  }

  /** Fetch server data for all known server instances. */
  private async fetchServerData(): Promise<void> {
    this._activeServer = await this.serverManager.getActiveServer()
  }

  private getStatusText(status: ServerInstance['status']): string {
    switch (status) {
      case ServerStatus.RUNNING:
        return 'Running'
      case ServerStatus.STARTING:
        return 'Starting...'
      case ServerStatus.STOPPED:
        return 'Stopped'
      case ServerStatus.ERROR:
        return 'Error'
      default:
        return 'Unknown'
    }
  }

  private getStatusIcon(status: ServerInstance['status']): string {
    switch (status) {
      case ServerStatus.RUNNING:
        return 'debug-start'
      case ServerStatus.STARTING:
        return 'loading~spin'
      case ServerStatus.STOPPED:
        return 'debug-stop'
      case ServerStatus.ERROR:
        return 'error'
      default:
        return 'question'
    }
  }

  private getStatusColor(status: ServerInstance['status']): string {
    switch (status) {
      case ServerStatus.RUNNING:
        return 'charts.green'
      case ServerStatus.STARTING:
        return 'charts.yellow'
      case ServerStatus.STOPPED:
        return 'charts.gray'
      case ServerStatus.ERROR:
        return 'charts.red'
      default:
        return 'charts.gray'
    }
  }
}
