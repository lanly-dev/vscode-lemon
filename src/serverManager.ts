import { ChildProcess, spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as vscode from 'vscode'
import { ExtensionContext , window } from 'vscode'
const { showErrorMessage, showInformationMessage, showWarningMessage } =  window
const { showInputBox,showQuickPick } = window

import { BinaryManager } from './binaryManager'
import { LemonadeClient } from './lemonadeClient'
import { Logger } from './logger'
import { ServerStatus, TargetServer } from './interfaces'

/**
 * Manages the Lemonade Server process lifecycle.
 */
export class ServerManager {
  private _embedPort: number = 8000
  private _standalonePort: number = 13305

  private _modelClient?: LemonadeClient
  private _serverName: string = ''
  private _serverUrl: string = ''
  private _status: ServerStatus = ServerStatus.STOPPED
  private _usingExistingServer = false

  private client: LemonadeClient
  private process: ChildProcess | null = null
  private statusChangeCallbacks: Array<(status: ServerStatus) => void> = []
  private selectionChangeCallbacks: Array<() => void> = []

  constructor(private context: ExtensionContext, private binaryManager: BinaryManager) {
    // Read configured ports so the getters/URLs reflect user settings immediately.
    const config = vscode.workspace.getConfiguration('lemon')
    this._embedPort = config.get<number>('embeddedPort', 8000)
    this._standalonePort = config.get<number>('serverPort', 13305)

    // Initialize the client for the default (embedded) server.
    this.client = new LemonadeClient(this._embedPort)

    // Apply the configured target server (standalone / embedded / custom).
    this.applyConfiguredServerMode()
  }

  /** Get the current server status. */
  get status(): ServerStatus {
    return this._status
  }

  /** Get the embedded server port. */
  get embeddedPort(): number {
    return this._embedPort
  }

  /** Get the standalone server port. */
  get standalonePort(): number {
    return this._standalonePort
  }

  /** Get the server URL. */
  get url(): string {
    return `http://localhost:${this._embedPort}`
  }

  /** Get the currently selected server URL for chat. */
  get selectedServerUrl(): string {
    if (this._serverUrl) return this._serverUrl
    return this.url
  }

  /** Get the name of the currently selected server. */
  get selectedServerName(): string {
    if (this._serverName) return this._serverName
    return 'lemon (Embedded)'
  }

  /** Get whether the embedded server is selected. */
  get isEmbeddedSelected(): boolean {
    return !this._serverUrl || this.selectedServerUrl === this.url
  }

  /** A client bound to the currently selected server for model operations. */
  getClient(): LemonadeClient {
    if (!this._modelClient) this._modelClient = new LemonadeClient(0)
    this._modelClient.setBaseUrl(this.selectedServerUrl)
    return this._modelClient
  }

  /**
   * Load a model on the selected server.
   * If no model name is supplied, the user is prompted to pick one.
   * Resolves to the loaded model name, or undefined if cancelled/failed.
   */
  async loadModel(modelName?: string): Promise<string | undefined> {
    if (!await this.ensureRunning()) return undefined
    const client = this.getClient()
    const name = await this.resolveModelName(modelName)
    if (!name) return undefined

    try {
      await window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Loading model: ${name}`,
          cancellable: false
        },
        async () => {
          await client.loadModel(name!)
        }
      )
      showInformationMessage(`Model '${name}' loaded successfully`)
      return name
    } catch (err: unknown) {
      Logger.error('Failed to load model', err)
      showErrorMessage(`Failed to load model: ${err}`)
      return undefined
    }
  }

  /**
   * Unload a model on the selected server.
   * If no model name is supplied, the user is prompted to pick one of the loaded models.
   * Resolves to the unloaded model name, or undefined if cancelled/failed.
   */
  async unloadModel(modelName?: string): Promise<string | void> {
    if (!await this.ensureRunning()) return
    const client = this.getClient()
    let name = modelName

    if (!name) {
      try {
        const health = await client.getHealth()
        const loadedModels = health.all_models_loaded.map((m) => m.model_name)
        if (loadedModels.length === 0) {
          showInformationMessage('No models are currently loaded')
          return
        }
        const items: vscode.QuickPickItem[] = loadedModels.map((m) => ({ label: m }))
        const selected = await showQuickPick(items, {
          title: 'Select a model to unload',
          placeHolder: 'Choose a model'
        })
        if (!selected) return
        name = selected.label
      } catch (err: unknown) {
        Logger.error('Failed to get loaded models', err)
        showErrorMessage(`Failed to get loaded models: ${err}`)
        return
      }
    }

    try {
      await client.unloadModel(name)
      showInformationMessage(`Model '${name}' unloaded successfully`)
    } catch (err: unknown) {
      Logger.error('Failed to unload model', err)
      showErrorMessage(`Failed to unload model: ${err}`)
    }
  }

  /**
   * Set the maximum number of concurrently loaded models.
   * Persists the value to the lemon.maxLoadedModels config, and if the
   * embedded server is running, pushes it to the running server immediately.
   */
  async setMaxLoadedModels(value: number): Promise<void> {
    const config = vscode.workspace.getConfiguration('lemon')
    await config.update('maxLoadedModels', value, vscode.ConfigurationTarget.Global)
    Logger.info(`Set lemon.maxLoadedModels to ${value}`)

    if (this._status === ServerStatus.RUNNING) {
      const client = this.getClient()
      await client.updateConfig({ max_loaded_models: value })
      Logger.info('Pushed max_loaded_models to running server')
    } else {
      showInformationMessage(
        'Server is not running. The setting will be applied on the next server start.'
      )
    }
  }

  /**
   * Select an active model for chat.
   * Prompts the user to pick a model from the available ones.
   * Resolves to the selected model name, or undefined if cancelled/error.
   */
  async selectModel(): Promise<string | undefined> {
    if (!await this.ensureRunning()) return undefined
    return this.promptForModel('Select active model for chat')
  }

  /** If a model name isn't provided, prompt the user to pick one from the available models. */
  private async resolveModelName(modelName?: string): Promise<string | undefined> {
    if (modelName) return modelName
    return this.promptForModel('Select a model to load')
  }

  /** Show a quick pick of the available models and return the selected model name. */
  private async promptForModel(title: string): Promise<string | undefined> {
    const client = this.getClient()

    try {
      const models = await client.listModels()
      if (models.length === 0) {
        showWarningMessage('No models available. Pull a model first.')
        return undefined
      }
      const items: vscode.QuickPickItem[] = models.map((m) => ({
        label: m.id,
        description: m.owned_by ?? ''
      }))
      const selected = await showQuickPick(items, {
        title,
        placeHolder: 'Choose a model'
      })
      return selected?.label
    } catch (err: unknown) {
      Logger.error('Failed to list models', err)
      showErrorMessage(`Failed to list models: ${err}`)
      return undefined
    }
  }

  /** Ensure a server is running, offering to start it if needed. */
  async ensureRunning(): Promise<boolean> {
    if (this._status === ServerStatus.RUNNING) return true
    const action = await showInformationMessage(
      'Lemonade Server is not running. Start it now?',
      'Start Server',
      'Cancel'
    )
    if (action !== 'Start Server') return false
    return this.start()
  }

  /** Set the selected server for chat and notify listeners (e.g. the chat participant). */
  setSelectedServer(url: string, name: string): void {
    this._serverUrl = url
    this._serverName = name
    Logger.info(`Selected server: ${name} (${url})`)
    for (const callback of this.selectionChangeCallbacks) callback()
  }

  /** Register a callback invoked whenever the selected chat server changes. */
  onServerSelectionChange(callback: () => void): void {
    this.selectionChangeCallbacks.push(callback)
  }

  /** Apply the configured `lemon.targetServer` to the in-memory server selection. */
  applyConfiguredServerMode(): void {
    const config = vscode.workspace.getConfiguration('lemon')
    const mode = config.get<TargetServer>('targetServer', TargetServer.STANDALONE)
    const standalonePort = config.get<number>('serverPort', 13305)
    const embeddedUrl = `http://localhost:${config.get<number>('embeddedPort', 8000)}`

    switch (mode) {
      case TargetServer.STANDALONE:
        this.setSelectedServer(`http://localhost:${standalonePort}`, 'Standalone Lemonade')
        break
      case TargetServer.CUSTOM: {
        const url = config.get<string>('customServerUrl', '')
        if (url) this.setSelectedServer(url, 'Custom Server')
        break
      }
      case TargetServer.EMBEDDED:
        this.setSelectedServer(embeddedUrl, 'lemon (Embedded)')
        break
      default:
        // Fall through to the default selection.
        break
    }
  }

  /** Show a quick pick to choose which server to use for chat. */
  async selectServer(): Promise<void> {
    const config = vscode.workspace.getConfiguration('lemon')
    const standalonePort = config.get<number>('serverPort', 13305)
    const embeddedPort = config.get<number>('embeddedPort', 8000)
    const standaloneUrl = `http://localhost:${standalonePort}`
    const embeddedUrl = `http://localhost:${embeddedPort}`
    const defaultUrl = config.get<string>('customServerUrl', '')

    // Check if standalone server is running
    let standaloneRunning = false
    try {
      const standaloneClient = new LemonadeClient(standalonePort)
      standaloneRunning = await standaloneClient.checkHealth()
    } catch {
      // Not running
    }

    const items: vscode.QuickPickItem[] = []

    // Standalone option
    if (standaloneRunning) {
      items.push({
        label: `$(server) Standalone Lemonade`,
        description: standaloneUrl,
        detail: 'The system-installed Lemonade Server',
        picked: !this.isEmbeddedSelected && this.selectedServerName === 'Standalone Lemonade'
      })
    }

    // Embedded option
    const embeddedStatus = this._status === ServerStatus.RUNNING
      ? 'Running'
      : this._status === ServerStatus.STARTING ? 'Starting...' : 'Stopped'
    items.push({
      label: `$(server-process) lemon (Embedded)`,
      description: embeddedUrl,
      detail: `The lemon binary managed by this extension (${embeddedStatus})`,
      picked: this.isEmbeddedSelected
    })

    // Custom URL option
    if (defaultUrl) {
      items.push({
        label: `$(globe) Custom Server`,
        description: defaultUrl,
        detail: 'A user-configured Lemonade Server URL',
        picked: !this.isEmbeddedSelected && this.selectedServerName === 'Custom Server'
      })
    }

    // Always include the option to add a custom URL
    items.push({
      label: '$(add) Add Custom Server URL...',
      description: '',
      detail: 'Enter any Lemonade Server URL to connect to'
    })

    const selected = await showQuickPick(items, {
      title: 'Select Server for Chat',
      placeHolder: 'Choose which Lemonade Server to use'
    })

    if (!selected) return

    // Handle "Add Custom Server URL..."
    if (selected.label.includes('Add Custom Server URL')) {
      const url = await showInputBox({
        title: 'Custom Server URL',
        prompt: 'Enter the Lemonade Server URL (e.g., http://localhost:13305)',
        placeHolder: 'http://localhost:13305',
        value: defaultUrl
      })
      if (!url) return

      // Save to config and select
      await config.update('customServerUrl', url, vscode.ConfigurationTarget.Global)
      await config.update('targetServer', TargetServer.CUSTOM, vscode.ConfigurationTarget.Global)
      this.setSelectedServer(url, 'Custom Server')
      showInformationMessage(`Connected to custom server: ${url}`)
      return
    }

    // Select the chosen server
    if (selected.label.includes('Standalone')) {
      await config.update('targetServer', TargetServer.STANDALONE, vscode.ConfigurationTarget.Global)
      this.setSelectedServer(standaloneUrl, 'Standalone Lemonade')
      showInformationMessage(`Using Standalone Lemonade at ${standaloneUrl}`)
    } else if (selected.label.includes('lemon')) {
      // If embedded server is not running, offer to start it
      if (this._status !== ServerStatus.RUNNING) {
        const start = await showInformationMessage(
          'The embedded lemon server is not running. Start it now?',
          'Start Server',
          'Cancel'
        )
        if (start === 'Start Server') {
          const started = await this.start()
          if (!started) {
            showErrorMessage('Failed to start the embedded lemon server')
            return
          }
        } else {
          await config.update('targetServer', TargetServer.EMBEDDED, vscode.ConfigurationTarget.Global)
          this.setSelectedServer(embeddedUrl, 'lemon (Embedded)')
          return
        }
      }
      await config.update('targetServer', TargetServer.EMBEDDED, vscode.ConfigurationTarget.Global)
      this.setSelectedServer(embeddedUrl, 'lemon (Embedded)')
      showInformationMessage(`Using lemon (Embedded) at ${embeddedUrl}`)
    } else if (selected.label.includes('Custom Server')) {
      await config.update('targetServer', TargetServer.CUSTOM, vscode.ConfigurationTarget.Global)
      this.setSelectedServer(defaultUrl, 'Custom Server')
      showInformationMessage(`Using custom server: ${defaultUrl}`)
    }
  }

  /** Register a callback for status changes. */
  onStatusChange(callback: (status: ServerStatus) => void): void {
    this.statusChangeCallbacks.push(callback)
  }

  /** Update the status and notify callbacks. */
  private setStatus(status: ServerStatus): void {
    this._status = status
    for (const callback of this.statusChangeCallbacks) callback(status)
  }


  /** Start the Lemonade Server. */
  async start(): Promise<boolean> {
    const config = vscode.workspace.getConfiguration('lemon')
    const serverMode = config.get<TargetServer>('targetServer', TargetServer.STANDALONE)

    // Custom mode: connect to a user-configured URL instead of launching a process.
    if (serverMode === TargetServer.CUSTOM) {
      const customUrl = config.get<string>('customServerUrl', '')
      if (!customUrl) {
        showErrorMessage('No custom Lemonade Server URL configured. Set lemon.customServerUrl in settings first.')
        this.setStatus(ServerStatus.ERROR)
        return false
      }
      const customClient = new LemonadeClient(0)
      customClient.setBaseUrl(customUrl)
      try {
        const healthy = await customClient.checkHealth()
        if (!healthy) throw new Error('health check failed')
        this.client = customClient
        this._usingExistingServer = true
        this.setSelectedServer(customUrl, 'Custom Server')
        this.setStatus(ServerStatus.RUNNING)
        showInformationMessage(`Connected to custom Lemonade Server at ${customUrl}`)
        return true
      } catch {
        this.setStatus(ServerStatus.ERROR)
        showErrorMessage(
          `Failed to connect to custom Lemonade Server at ${customUrl}.`
        )
        return false
      }
    }

    if (this._status === ServerStatus.RUNNING || this._status === ServerStatus.STARTING) {
      Logger.warn('Server is already running or starting')
      showInformationMessage('Lemonade Server is already running')
      return true
    }

    // Read ports from config
    this._standalonePort = config.get<number>('serverPort', 13305)
    this._embedPort = config.get<number>('embeddedPort', 8000)

    // Standalone mode: require an existing running standalone server.
    if (serverMode === TargetServer.STANDALONE) {
      Logger.info('Connecting to standalone Lemonade Server...')
      const standaloneClient = new LemonadeClient(this._standalonePort)
      const standaloneHealthy = await standaloneClient.checkHealth()
      if (standaloneHealthy) {
        this._usingExistingServer = true
        this.client = standaloneClient
        this.setSelectedServer(`http://localhost:${this._standalonePort}`, 'Standalone Lemonade')
        this.setStatus(ServerStatus.RUNNING)
        showInformationMessage(`Connected to Standalone Lemonade at http://localhost:${this._standalonePort}`)
        return true
      }
      this.setStatus(ServerStatus.ERROR)
      showErrorMessage(
        'Standalone Lemonade Server is not running. Start it, or set lemon.targetServer to "embedded" or "custom".'
      )
      return false
    }

    // Embedded mode: always start the embedded binary (do not auto-connect to standalone).
    if (serverMode === TargetServer.EMBEDDED) this.setSelectedServer(this.url, 'lemon (Embedded)')

    // No standalone server found (or embedded mode forced), start embedded lemon
    this.client = new LemonadeClient(this._embedPort)

    // Check if the embedded port is in use by something else
    const portInUse = await this.isPortInUse(this._embedPort)
    if (portInUse) {
      showErrorMessage(
        `Port ${this._embedPort} is already in use by another application. `
        + 'Please change the port in settings (lemon.embeddedPort).'
      )
      this.setStatus(ServerStatus.ERROR)
      return false
    }

    // Ensure binary is installed
    const installed = await this.binaryManager.ensureBinary()
    if (!installed) {
      this.setStatus(ServerStatus.ERROR)
      return false
    }

    this._usingExistingServer = false
    this.setStatus(ServerStatus.STARTING)
    Logger.info(`Starting embedded Lemonade Server on port ${this._embedPort}...`)

    const binaryPath = this.binaryManager.binaryPath
    const workingDir = this.binaryManager.binaryDir

    // Write config.json with the embedded port so lemon uses it.
    // Use default cache directory to avoid Windows permission issues.
    try {
      const configPath = path.join(workingDir, 'config.json')
      const config = vscode.workspace.getConfiguration('lemon')
      const maxLoadedModels = config.get<number>('maxLoadedModels', 1)
      const configData = {
        port: this._embedPort,
        max_loaded_models: maxLoadedModels
      }
      fs.writeFileSync(configPath, JSON.stringify(configData, null, 2), 'utf8')
      Logger.info(`Wrote config.json with port ${this._embedPort} and max_loaded_models ${maxLoadedModels}`)
    } catch (err) {
      Logger.error('Failed to write config.json', err)
    }

    try {
      // lemon [cache_dir] [--port PORT] [--host HOST]
      this.process = spawn(binaryPath, [workingDir, '--port', String(this._embedPort)], {
        cwd: workingDir,
        env: { ...process.env },
        shell: false
      })
    } catch (err) {
      Logger.error('Failed to start server process', err)
      this.setStatus(ServerStatus.ERROR)
      showErrorMessage(`Failed to start Lemonade Server: ${err}`)
      return false
    }

    // Handle process output
    this.process.stdout?.on('data', (data: Buffer) => {
      const text = data.toString().trim()
      if (text) Logger.info(`[lemon] ${text}`)
    })

    this.process.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim()
      if (text) Logger.warn(`[lemon] ${text}`)
    })

    this.process.on('error', (err) => {
      Logger.error('Server process error', err)
      this.setStatus(ServerStatus.ERROR)
      showErrorMessage(`Lemonade Server error: ${err.message}`)
    })

    this.process.on('exit', (code, signal) => {
      Logger.info(`Server process exited (code: ${code}, signal: ${signal})`)
      this.process = null
      if (this._status !== ServerStatus.STOPPED) this.setStatus(ServerStatus.STOPPED)
    })

    // Wait for the server to be ready
    const ready = await this.waitForReady()
    if (ready) {
      this.setSelectedServer(`http://localhost:${this._embedPort}`, 'lemon (Embedded)')
      this.setStatus(ServerStatus.RUNNING)
      Logger.info('Lemonade Server is ready')
      showInformationMessage('Lemonade Server started successfully')
      return true
    }
    Logger.error('Server failed to become ready within timeout')
    this.setStatus(ServerStatus.ERROR)
    showErrorMessage('Lemonade Server failed to start within 60 seconds. Check the output for details.')
    return false
  }

  /** Check if a Lemonade Server is already running on the standalone port. */
  private async checkExistingServer(): Promise<boolean> {
    try {
      Logger.info(`Checking for existing server on port ${this._standalonePort}...`)
      const standaloneClient = new LemonadeClient(this._standalonePort)
      const healthy = await standaloneClient.checkHealth()
      if (healthy) {
        Logger.info('Found existing Lemonade Server')
        return true
      }
    } catch {
      // No server running on this port
      Logger.info('No existing server found')
    }
    return false
  }

  /** Check if a port is in use (by any application). */
  private async isPortInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const net = require('net')
      const tester = net.createServer()
      tester.once('error', () => resolve(true))
      tester.once('listening', () => {
        tester.close()
        resolve(false)
      })
      tester.listen(port)
    })
  }

  /** Wait for the server to respond to health checks. */
  private async waitForReady(timeoutMs: number = 60000): Promise<boolean> {
    const startTime = Date.now()
    const checkInterval = 1000

    while (Date.now() - startTime < timeoutMs) {
      try {
        const healthy = await this.client.checkHealth()
        if (healthy) return true
      } catch {
        // Server not ready yet, continue waiting
      }
      await new Promise((resolve) => setTimeout(resolve, checkInterval))
    }
    return false
  }

  /** Stop the Lemonade Server. */
  async stop(): Promise<void> {
    // If using an existing server, just disconnect
    if (this._usingExistingServer) {
      Logger.info('Disconnecting from existing Lemonade Server')
      this._usingExistingServer = false
      this.setStatus(ServerStatus.STOPPED)
      showInformationMessage('Disconnected from Lemonade Server')
      return
    }

    if (!this.process) {
      Logger.info('Server is not running')
      this.setStatus(ServerStatus.STOPPED)
      return
    }

    Logger.info('Stopping Lemonade Server...')

    // Try graceful shutdown via API
    try {
      await this.client.unloadAllModels()
    } catch {
      // Ignore errors, we're shutting down anyway
    }

    // Kill the process
    if (this.process && !this.process.killed) {
      this.process.kill('SIGTERM')
      // Wait a bit for graceful shutdown
      await new Promise((resolve) => setTimeout(resolve, 2000))
      if (this.process && !this.process.killed) {
        Logger.warn('Server did not respond to SIGTERM, sending SIGKILL')
        this.process.kill('SIGKILL')
      }
    }

    this.process = null
    this.setStatus(ServerStatus.STOPPED)
    Logger.info('Lemonade Server stopped')
    showInformationMessage('Lemonade Server stopped')
  }

  /** Restart the Lemonade Server. */
  async restart(): Promise<boolean> {
    await this.stop()
    await new Promise((resolve) => setTimeout(resolve, 1000))
    return this.start()
  }

  /** Check if the server is running and healthy. */
  async isHealthy(): Promise<boolean> {
    if (this._status !== ServerStatus.RUNNING) return false
    try {
      return await this.client.checkHealth()
    } catch {
      return false
    }
  }

  /** Dispose of resources. */
  dispose(): void {
    // Only kill the process if we started it
    if (!this._usingExistingServer && this.process && !this.process.killed) this.process.kill('SIGKILL')
    this.process = null
    this._usingExistingServer = false
  }
}
