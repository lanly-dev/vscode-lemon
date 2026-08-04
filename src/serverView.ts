import * as vscode from 'vscode'
import { Logger } from './logger'
import { LemonadeClient } from './lemonadeClient'
import { ServerManager } from './serverManager'
import { BinaryManager } from './binaryManager'
import type { HealthResponse, LemonadeModel } from './interfaces'

/** A server instance shown in the tree view. */
interface ServerInstance {
  id: string
  name: string
  url: string
  isOwn: boolean
  status: 'running' | 'stopped' | 'starting' | 'error'
  version?: string
  health?: HealthResponse
  models?: LemonadeModel[]
  error?: string
  maxLoadedModels?: number
}

/**
 * Tree data provider for the Servers view.
 * Shows both the standalone Lemonade app and the lemond app in a single tree.
 */
export class ServerViewProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>()
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event

  private client: LemonadeClient
  private standaloneServer: ServerInstance | null = null
  private lemondServer: ServerInstance | null = null

  constructor(
    private serverManager: ServerManager,
    private binaryManager: BinaryManager
  ) {
    this.client = new LemonadeClient(serverManager.port)

    serverManager.onStatusChange(() =>  this.refresh())
  }

  /** Refresh the tree view. */
  refresh(): void {
    this._onDidChangeTreeData.fire()
  }

  /** Get the tree item for the given element. */
  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element
  }

  /** Get children of the given element (or root if undefined). */
  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element)
      return this.getChildrenForElement(element)

    // Root level - fetch fresh data
    await this.fetchServerData()

    const items: vscode.TreeItem[] = []

    // Auto-detect which server to show: prefer standalone if running
    let displayServer: ServerInstance | null = null
    let displayName = ''
    let displayUrl = ''

    // Check if we should show a switch prompt
    const showSwitchPrompt = this.standaloneServer?.status === 'running'
      && this.serverManager.isEmbeddedSelected
      && this.lemondServer?.status === 'running'

    if (this.standaloneServer?.status === 'running') {
      // Show standalone server if it's running
      displayServer = this.standaloneServer
      displayName = 'Standalone Lemonade'
      displayUrl = this.standaloneServer.url
    } else if (this.lemondServer?.status === 'running') {
      // Fall back to embedded server if running
      displayServer = this.lemondServer
      displayName = 'lemond (Embedded)'
      displayUrl = this.lemondServer.url
    } else if (this.standaloneServer?.status === 'starting') {
      // Show standalone if it's starting
      displayServer = this.standaloneServer
      displayName = 'Standalone Lemonade'
      displayUrl = this.standaloneServer.url
    } else if (this.lemondServer?.status === 'starting') {
      // Show embedded if it's starting
      displayServer = this.lemondServer
      displayName = 'lemond (Embedded)'
      displayUrl = this.lemondServer.url
    } else {
      // No server running, show embedded (stopped) by default
      displayServer = this.lemondServer
      displayName = 'lemond (Embedded)'
      displayUrl = this.lemondServer?.url || `http://localhost:8000`
    }

    // Add switch prompt as first item if standalone is running and embedded is selected
    if (showSwitchPrompt && this.standaloneServer?.status === 'running') {
      const switchItem = new vscode.TreeItem(
        '$(arrow-right) Switch to Standalone Lemonade',
        vscode.TreeItemCollapsibleState.None
      )
      switchItem.iconPath = new vscode.ThemeIcon('server')
      switchItem.contextValue = 'LEMOND_SWITCH_TO_STANDALONE'
      switchItem.tooltip = 'Click to switch from embedded to standalone Lemonade Server'
      switchItem.command = {
        command: 'lemond.switchToStandalone',
        title: 'Switch to Standalone',
        arguments: []
      }
      items.push(switchItem)
    }

    // Show single active server
    const serverHeader = new vscode.TreeItem(
      displayName,
      vscode.TreeItemCollapsibleState.Expanded
    )
    serverHeader.iconPath = new vscode.ThemeIcon('server')
    serverHeader.contextValue = 'LEMOND_SERVER_HEADER'
    serverHeader.tooltip = `Active server: ${displayName}\nURL: ${displayUrl}`
    items.push(serverHeader)

    // Store the active server reference for child elements
    this._activeServer = displayServer

    return items
  }

  private _activeServer: ServerInstance | null = null

  /** Get children for a specific element. */
  private getChildrenForElement(element: vscode.TreeItem): vscode.TreeItem[] {
    if (element.contextValue === 'LEMOND_SERVER_HEADER') return this.getServerChildren(this._activeServer)
    if (element.contextValue === 'LEMOND_LOADED_HEADER') return this.getLoadedModelChildren(element)
    if (element.contextValue === 'LEMOND_MODELS_HEADER') return this.getModelChildren(element)
    return []
  }

  /** Get children for a server instance. */
  private getServerChildren(server: ServerInstance | null): vscode.TreeItem[] {
    if (!server) return []

    const items: vscode.TreeItem[] = []

    // Status indicator
    const statusText = this.getStatusText(server.status)
    const statusItem = new vscode.TreeItem(
      `Status: ${statusText}`,
      vscode.TreeItemCollapsibleState.None
    )
    statusItem.iconPath = new vscode.ThemeIcon(
      this.getStatusIcon(server.status),
      new vscode.ThemeColor(this.getStatusColor(server.status))
    )
    statusItem.contextValue = 'LEMOND_SERVER_STATUS'
    items.push(statusItem)

    // Server URL
    const urlItem = new vscode.TreeItem(
      server.url,
      vscode.TreeItemCollapsibleState.None
    )
    urlItem.iconPath = new vscode.ThemeIcon('link')
    urlItem.tooltip = `Server URL: ${server.url}`
    urlItem.contextValue = 'LEMOND_SERVER_URL'
    items.push(urlItem)

    // Version
    if (server.version) {
      const versionItem = new vscode.TreeItem(
        `Version: v${server.version}`,
        vscode.TreeItemCollapsibleState.None
      )
      versionItem.iconPath = new vscode.ThemeIcon('versions')
      versionItem.tooltip = 'Lemonade Server binary version'
      items.push(versionItem)
    }

    // Max loaded models
    if (server.maxLoadedModels !== undefined) {
      const maxModelsText = server.maxLoadedModels === -1
        ? 'Unlimited'
        : String(server.maxLoadedModels)
      const maxModelsItem = new vscode.TreeItem(
        `Max Loaded Models: ${maxModelsText}`,
        vscode.TreeItemCollapsibleState.None
      )
      maxModelsItem.iconPath = new vscode.ThemeIcon('stack')
      const configLabel = server.isOwn ? ' (configured in settings)' : ''
      maxModelsItem.tooltip = `Maximum models that can be loaded simultaneously${configLabel}`
      items.push(maxModelsItem)
    }

    // Error message if any
    if (server.error) {
      const errorItem = new vscode.TreeItem(
        `Error: ${server.error}`,
        vscode.TreeItemCollapsibleState.None
      )
      errorItem.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'))
      items.push(errorItem)
    }

    // Loaded models section
    if (server.health && server.health.all_models_loaded.length > 0) {
      const loadedHeader = new vscode.TreeItem(
        `Loaded Models (${server.health.all_models_loaded.length})`,
        vscode.TreeItemCollapsibleState.Expanded
      )
      loadedHeader.iconPath = new vscode.ThemeIcon('zap')
      loadedHeader.contextValue = 'LEMOND_LOADED_HEADER'
      loadedHeader.tooltip = server.id
      items.push(loadedHeader)
    }

    // Available models section
    if (server.models && server.models.length > 0) {
      const modelsHeader = new vscode.TreeItem(
        `Available Models (${server.models.length})`,
        vscode.TreeItemCollapsibleState.Expanded
      )
      modelsHeader.iconPath = new vscode.ThemeIcon('list-tree')
      modelsHeader.contextValue = 'LEMOND_MODELS_HEADER'
      modelsHeader.tooltip = server.id
      items.push(modelsHeader)
    } else if (server.status === 'running') {
      const noModels = new vscode.TreeItem(
        'No models available',
        vscode.TreeItemCollapsibleState.None
      )
      noModels.iconPath = new vscode.ThemeIcon('circle-filled')
      noModels.tooltip = 'Pull a model using the "Lemonade: Pull Model" command'
      items.push(noModels)
    }
    return items
  }

  /** Get loaded model children. */
  private getLoadedModelChildren(element: vscode.TreeItem): vscode.TreeItem[] {
    const server = this.findServerByTooltip(element.tooltip)
    if (!server?.health)
      return []

    return server.health.all_models_loaded.map((model) => {
      const item = new vscode.TreeItem(
        model.model_name,
        vscode.TreeItemCollapsibleState.None
      )
      item.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'))
      item.tooltip = `Model: ${model.model_name}\nBusy: ${model.is_busy}\nStreaming: ${model.is_streaming}`
      item.contextValue = 'LEMOND_LOADED_MODEL'
      item.description = model.is_busy ? 'busy' : 'idle'
      return item
    })
  }

  /** Get available model children. */
  private getModelChildren(element: vscode.TreeItem): vscode.TreeItem[] {
    const server = this.findServerByTooltip(element.tooltip)
    if (!server?.models) return []

    const loadedIds = new Set(
      server.health?.all_models_loaded.map((m) => m.model_name) ?? []
    )

    return server.models.map((model) => {
      const isLoaded = loadedIds.has(model.id)
      const item = new vscode.TreeItem(
        model.id,
        vscode.TreeItemCollapsibleState.None
      )
      item.iconPath = new vscode.ThemeIcon(
        isLoaded ? 'pass-filled' : 'circle',
        isLoaded ? new vscode.ThemeColor('charts.green') : undefined
      )
      item.tooltip = `Model: ${model.id}\nStatus: ${isLoaded ? 'Loaded' : 'Available'}`
      item.contextValue = isLoaded ? 'LEMOND_MODEL_LOADED' : 'LEMOND_MODEL_AVAILABLE'
      item.description = isLoaded ? 'Loaded' : 'Available'
      return item
    })
  }

  /** Find a server instance by its tooltip id. */
  private findServerByTooltip(tooltip: vscode.TreeItem['tooltip']): ServerInstance | null {
    const id = typeof tooltip === 'string' ? tooltip : ''
    if (this.standaloneServer?.id === id) return this.standaloneServer
    if (this.lemondServer?.id === id) return this.lemondServer
    return null
  }

  /** Fetch server data for both instances. */
  private async fetchServerData(): Promise<void> {
    // Check for standalone Lemonade server on the standalone port
    const config = vscode.workspace.getConfiguration('lemond')
    const standalonePort = config.get<number>('serverPort', 13305)
    const embeddedPort = config.get<number>('embeddedPort', 8000)
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
        status: 'running',
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
        status: 'stopped'
      }
    }

    // Check lemond server
    if (this.serverManager.status === 'running') {
      try {
        const health = await this.client.getHealth()
        const models = await this.client.listModels()
        const config = vscode.workspace.getConfiguration('lemond')
        const maxLoadedModels = config.get<number>('maxLoadedModels', 1)
        this.lemondServer = {
          id: 'lemond',
          name: 'lemond (Embedded)',
          url: this.serverManager.url,
          isOwn: true,
          status: 'running',
          version: this.binaryManager.getInstalledVersion() ?? undefined,
          health,
          models,
          maxLoadedModels
        }
      } catch (err) {
        this.lemondServer = {
          id: 'lemond',
          name: 'lemond (Embedded)',
          url: this.serverManager.url,
          isOwn: true,
          status: 'error',
          version: this.binaryManager.getInstalledVersion() ?? undefined,
          error: err instanceof Error ? err.message : String(err)
        }
      }
    } else {
      const config = vscode.workspace.getConfiguration('lemond')
      const maxLoadedModels = config.get<number>('maxLoadedModels', 1)
      this.lemondServer = {
        id: 'lemond',
        name: 'lemond (Embedded)',
        url: this.serverManager.url,
        isOwn: true,
        status: this.serverManager.status,
        version: this.binaryManager.getInstalledVersion() ?? undefined,
        maxLoadedModels
      }
    }
  }

  /** Get the status text for a server status. */
  private getStatusText(status: ServerInstance['status']): string {
    switch (status) {
    case 'running':
      return 'Running'
    case 'starting':
      return 'Starting...'
    case 'stopped':
      return 'Stopped'
    case 'error':
      return 'Error'
    default:
      return 'Unknown'
    }
  }

  /** Get the status icon for a server status. */
  private getStatusIcon(status: ServerInstance['status']): string {
    switch (status) {
    case 'running':
      return 'debug-start'
    case 'starting':
      return 'loading~spin'
    case 'stopped':
      return 'debug-stop'
    case 'error':
      return 'error'
    default:
      return 'question'
    }
  }

  /** Get the status color for a server status. */
  private getStatusColor(status: ServerInstance['status']): string {
    switch (status) {
    case 'running':
      return 'charts.green'
    case 'starting':
      return 'charts.yellow'
    case 'stopped':
      return 'charts.gray'
    case 'error':
      return 'charts.red'
    default:
      return 'charts.gray'
    }
  }
}
