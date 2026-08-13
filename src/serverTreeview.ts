import * as vscode from 'vscode'

import { TreeDataProvider, TreeItem, TreeItemCollapsibleState } from 'vscode'
const { None, Expanded } = TreeItemCollapsibleState

import { BinaryManager } from './binaryManager'
import { LemonadeClient } from './lemonadeClient'
import { Logger } from './logger'
import { ServerManager } from './serverManager'
import { ServerStatus } from './interfaces'

import type { ServerInstance } from './interfaces'

/**
 * Tree data provider for the Servers view.
 * Shows both the standalone Lemonade app and the lemon app in a single tree.
 */
export class ServerViewProvider implements TreeDataProvider<TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  private _activeServer: ServerInstance | null = null

  private client: LemonadeClient
  private standaloneServer: ServerInstance | null = null
  private customServer: ServerInstance | null = null
  private lemonServer: ServerInstance | null = null

  constructor(private serverManager: ServerManager, private binaryManager: BinaryManager) {
    this.client = new LemonadeClient(serverManager.embeddedPort)
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

    // Determine which server to display as the active one.
    // Prefer the explicitly selected server; otherwise auto-pick running → starting → default (embedded).
    let displayServer: ServerInstance | null = null
    let displayName = ''
    let displayUrl = ''

    const candidates: Array<{ server: ServerInstance | null, name: string }> = [
      { server: this.standaloneServer, name: 'Standalone Lemonade' },
      { server: this.customServer, name: 'Custom Server' },
      { server: this.lemonServer, name: 'lemon (Embedded)' }
    ]

    // 1. Respect an explicit selection (by matching the selected server name).
    const selectedName = this.serverManager.selectedServerName
    const selectedMatch = candidates.find((c) => c.server && c.name === selectedName)
    if (selectedMatch?.server) {
      displayServer = selectedMatch.server
      displayName = selectedMatch.name
      displayUrl = selectedMatch.server.url
    } else {
      // 2. Auto-pick the first running server.
      const running = candidates.find((c) => c.server?.status === ServerStatus.RUNNING)
      if (running?.server) {
        displayServer = running.server
        displayName = running.name
        displayUrl = running.server.url
      } else {
        // 3. Any server that is starting.
        const starting = candidates.find((c) => c.server?.status === ServerStatus.STARTING)
        if (starting?.server) {
          displayServer = starting.server
          displayName = starting.name
          displayUrl = starting.server.url
        } else {
          // 4. Default to embedded (stopped).
          displayServer = this.lemonServer
          displayName = 'lemon (Embedded)'
          displayUrl = this.lemonServer?.url || `http://localhost:8000`
        }
      }
    }

    // Show single active server
    const serverHeader = new TreeItem(displayName, Expanded)
    serverHeader.iconPath = new vscode.ThemeIcon('server')
    serverHeader.contextValue = 'LEMOND_SERVER_HEADER'
    serverHeader.tooltip = `Active server: ${displayName}\nURL: ${displayUrl}`
    items.push(serverHeader)

    // Store the active server reference for child elements
    this._activeServer = displayServer

    // Loaded models section
    const loadedModels = this._activeServer?.health?.all_models_loaded || []

    const loadedHeader = new TreeItem(`Loaded Models (${loadedModels.length})`, Expanded)
    loadedHeader.iconPath = new vscode.ThemeIcon('zap')
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
    if (element.contextValue === 'LEMOND_SERVER_HEADER') return this.getServerChildren(this._activeServer)
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
    statusItem.contextValue = 'LEMOND_SERVER_STATUS'
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
      const configLabel = server.isOwn ? ' (configured in settings)' : ''
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
      const item = new TreeItem(model.id, None)
      if (isLoaded) {
        item.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'))
        item.contextValue = 'LEMOND_MODEL_LOADED'
      } else {
        item.iconPath = new vscode.ThemeIcon('circle')
        item.tooltip = `Model: ${model.id}`
        item.contextValue = 'LEMOND_MODEL_AVAILABLE'
      }
      return item
    })
  }

  /** Find a server instance by its tooltip id. */
  private findServerByTooltip(tooltip: vscode.TreeItem['tooltip']): ServerInstance | null {
    const id = typeof tooltip === 'string' ? tooltip : ''
    if (this.standaloneServer?.id === id) return this.standaloneServer
    if (this.customServer?.id === id) return this.customServer
    if (this.lemonServer?.id === id) return this.lemonServer
    return null
  }

  /** Fetch server data for both instances. */
  private async fetchServerData(): Promise<void> {
    // Check for standalone Lemonade server on the standalone port
    const config = vscode.workspace.getConfiguration('lemon')
    const standalonePort = config.get<number>('serverPort', 13305)
    const standaloneClient = new LemonadeClient(standalonePort)

    // Check standalone server
    try {
      const health = await standaloneClient.getHealth()
      const models = await standaloneClient.listModels()
      this.standaloneServer = {
        id: 'standalone',
        name: 'Standalone Lemonade',
        url: `http://localhost:${standalonePort}`,
        isOwn: false,
        status: ServerStatus.RUNNING,
        health,
        models,
        maxLoadedModels: health.all_models_loaded.length
      }
    } catch {
      this.standaloneServer = {
        id: 'standalone',
        name: 'Standalone Lemonade',
        url: `http://localhost:${standalonePort}`,
        isOwn: false,
        status: ServerStatus.STOPPED
      }
    }

    // Check custom server (lemon.customServerUrl)
    const customUrl = config.get<string>('customServerUrl', '')
    if (customUrl) {
      const customClient = new LemonadeClient(0)
      customClient.setBaseUrl(customUrl)
      try {
        const health = await customClient.getHealth()
        const models = await customClient.listModels()
        this.customServer = {
          id: 'custom',
          name: 'Custom Server',
          url: customUrl,
          isOwn: false,
          status: ServerStatus.RUNNING,
          health,
          models,
          maxLoadedModels: health.all_models_loaded.length
        }
      } catch {
        this.customServer = {
          id: 'custom',
          name: 'Custom Server',
          url: customUrl,
          isOwn: false,
          status: ServerStatus.STOPPED
        }
      }
    } else this.customServer = null

    // Check lemond server
    if (this.serverManager.status === ServerStatus.RUNNING) {
      try {
        const health = await this.client.getHealth()
        const models = await this.client.listModels()
        let maxLoadedModels = config.get<number>('maxLoadedModels', 1)

        // If the server reports its max_loaded_models, keep the extension config in sync
        if (typeof health.max_loaded_models === 'number' && Number.isInteger(health.max_loaded_models)) {
          maxLoadedModels = health.max_loaded_models
          if (config.get<number>('maxLoadedModels', 1) !== maxLoadedModels) {
            await config.update('maxLoadedModels', maxLoadedModels, vscode.ConfigurationTarget.Global)
            Logger.info(`Synced lemon.maxLoadedModels from server to ${maxLoadedModels}`)
          }
        }

        this.lemonServer = {
          id: 'lemon',
          name: 'lemon (Embedded)',
          url: this.serverManager.url,
          isOwn: true,
          status: ServerStatus.RUNNING,
          version: this.binaryManager.getInstalledVersion() ?? undefined,
          health,
          models,
          maxLoadedModels
        }
      } catch (err) {
        this.lemonServer = {
          id: 'lemon',
          name: 'lemon (Embedded)',
          url: this.serverManager.url,
          isOwn: true,
          status: ServerStatus.ERROR,
          version: this.binaryManager.getInstalledVersion() ?? undefined,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    } else {
      const maxLoadedModels = config.get<number>('maxLoadedModels', 1)
      this.lemonServer = {
        id: 'lemon',
        name: 'lemon (Embedded)',
        url: this.serverManager.url,
        isOwn: true,
        status: this.serverManager.status,
        version: this.binaryManager.getInstalledVersion() ?? undefined,
        maxLoadedModels
      }
    }
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
