import * as vscode from 'vscode'

import { TreeDataProvider, TreeItem, TreeItemCollapsibleState } from 'vscode'
const { None, Expanded } = TreeItemCollapsibleState

import { ServerManager } from './serverManager'
import { ServerStatus } from './interfaces'
import { getModelLabel } from './modelLabel'

import type { ServerInstance } from './interfaces'

/**
 * Tree data provider for the Servers view.
 * Shows both the standalone Lemonade app and the lemon app in a single tree.
 */
export class ServerViewProvider implements TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  private _activeServer: ServerInstance | null = null

  constructor(private serverManager: ServerManager) {
    serverManager.onStatusChange(() => this.refresh())
  }

  refresh(): void {
    this._onDidChangeTreeData.fire()
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
