import { ChildProcess, spawn } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as vscode from 'vscode'
import { Logger } from './logger'
import { BinaryManager } from './binaryManager'
import { LemonadeClient } from './lemonadeClient'
import type { ServerStatus } from './types'

/**
 * Manages the Lemonade Server process lifecycle.
 */
export class ServerManager {
  private process: ChildProcess | null = null
  private _status: ServerStatus = 'stopped'
  private _port: number = 8000
  private _standalonePort: number = 13305
  private _usingExistingServer = false
  private _serverUrl: string = ''
  private _serverName: string = ''
  private statusBarItem: vscode.StatusBarItem
  private statusChangeCallbacks: Array<(status: ServerStatus) => void> = []
  private client: LemonadeClient

  constructor(
    private context: vscode.ExtensionContext,
    private binaryManager: BinaryManager
  ) {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      100
    )
    this.statusBarItem.command = 'lemond.startServer'
    this.context.subscriptions.push(this.statusBarItem)
    this.client = new LemonadeClient(this.port)
    this.updateStatusBar()
  }

  /** Get the current server status. */
  get status(): ServerStatus {
    return this._status
  }

  /** Get the embedded server port. */
  get port(): number {
    return this._port
  }

  /** Get the standalone server port. */
  get standalonePort(): number {
    return this._standalonePort
  }

  /** Get the server URL. */
  get url(): string {
    return `http://localhost:${this._port}`
  }

  /** Get whether we're using an existing server. */
  get usingExistingServer(): boolean {
    return this._usingExistingServer
  }

  /** Get the currently selected server URL for chat. */
  get selectedServerUrl(): string {
    if (this._serverUrl)
      return this._serverUrl
    return this.url
  }

  /** Get the name of the currently selected server. */
  get selectedServerName(): string {
    if (this._serverName)
      return this._serverName
    return 'lemond (Embedded)'
  }

  /** Get whether the embedded server is selected. */
  get isEmbeddedSelected(): boolean {
    return !this._serverUrl || this.selectedServerUrl === this.url
  }

  /** Set the selected server for chat. */
  setSelectedServer(url: string, name: string): void {
    this._serverUrl = url
    this._serverName = name
    Logger.info(`Selected server: ${name} (${url})`)
    this.updateStatusBar()
  }

  /** Show a quick pick to choose which server to use for chat. */
  async selectServer(): Promise<void> {
    const config = vscode.workspace.getConfiguration('lemond')
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
    const embeddedStatus = this._status === 'running'
      ? 'Running'
      : this._status === 'starting' ? 'Starting...' : 'Stopped'
    items.push({
      label: `$(server-process) lemond (Embedded)`,
      description: embeddedUrl,
      detail: `The lemond binary managed by this extension (${embeddedStatus})`,
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

    const selected = await vscode.window.showQuickPick(items, {
      title: 'Select Server for Chat',
      placeHolder: 'Choose which Lemonade Server to use'
    })

    if (!selected)
      return

    // Handle "Add Custom Server URL..."
    if (selected.label.includes('Add Custom Server URL')) {
      const url = await vscode.window.showInputBox({
        title: 'Custom Server URL',
        prompt: 'Enter the Lemonade Server URL (e.g., http://localhost:13305)',
        placeHolder: 'http://localhost:13305',
        value: defaultUrl
      })
      if (!url)
        return

      // Save to config and select
      await config.update('customServerUrl', url, vscode.ConfigurationTarget.Global)
      this.setSelectedServer(url, 'Custom Server')
      vscode.window.showInformationMessage(`Connected to custom server: ${url}`)
      return
    }

    // Select the chosen server
    if (selected.label.includes('Standalone')) {
      this.setSelectedServer(standaloneUrl, 'Standalone Lemonade')
      vscode.window.showInformationMessage(`Using Standalone Lemonade at ${standaloneUrl}`)
    } else if (selected.label.includes('lemond')) {
      // If embedded server is not running, offer to start it
      if (this._status !== 'running') {
        const start = await vscode.window.showInformationMessage(
          'The embedded lemond server is not running. Start it now?',
          'Start Server',
          'Cancel'
        )
        if (start === 'Start Server') {
          const started = await this.start()
          if (!started) {
            vscode.window.showErrorMessage('Failed to start the embedded lemond server')
            return
          }
        } else {
          this.setSelectedServer(embeddedUrl, 'lemond (Embedded)')
          return
        }
      }
      this.setSelectedServer(embeddedUrl, 'lemond (Embedded)')
      vscode.window.showInformationMessage(`Using lemond (Embedded) at ${embeddedUrl}`)
    } else if (selected.label.includes('Custom Server')) {
      this.setSelectedServer(defaultUrl, 'Custom Server')
      vscode.window.showInformationMessage(`Using custom server: ${defaultUrl}`)
    }
  }

  /** Register a callback for status changes. */
  onStatusChange(callback: (status: ServerStatus) => void): void {
    this.statusChangeCallbacks.push(callback)
  }

  /** Update the status and notify callbacks. */
  private setStatus(status: ServerStatus): void {
    this._status = status
    this.updateStatusBar()
    for (const callback of this.statusChangeCallbacks)
      callback(status)
  }

  /** Update the status bar item. */
  private updateStatusBar(): void {
    const icons: Record<ServerStatus, string> = {
      stopped: '$(debug-stop)',
      starting: '$(loading~spin)',
      running: '$(pass-filled)',
      error: '$(error)'
    }
    const labels: Record<ServerStatus, string> = {
      stopped: 'Lemonade: Stopped',
      starting: 'Lemonade: Starting...',
      running: this._usingExistingServer ? 'Lemonade: Connected' : 'Lemonade: Running',
      error: 'Lemonade: Error'
    }
    this.statusBarItem.text = `${icons[this._status]} ${labels[this._status]}`
    const mode = this._usingExistingServer ? 'Connected to' : 'Running at'
    const selected = this._serverName
      ? `Chat: ${this._serverName}`
      : ''
    this.statusBarItem.tooltip = `Lemonade Server - ${mode} ${this.url}\n${selected}`
    this.statusBarItem.show()
  }

  /** Start the Lemonade Server. */
  async start(): Promise<boolean> {
    if (this._status === 'running' || this._status === 'starting') {
      Logger.warn('Server is already running or starting')
      vscode.window.showInformationMessage('Lemonade Server is already running')
      return true
    }

    // Read ports from config
    const config = vscode.workspace.getConfiguration('lemond')
    this._standalonePort = config.get<number>('serverPort', 13305)
    this._port = config.get<number>('embeddedPort', 8000)

    // Check if standalone Lemonade is already running
    Logger.info('Checking for standalone Lemonade Server...')
    const standaloneClient = new LemonadeClient(this._standalonePort)
    const standaloneHealthy = await standaloneClient.checkHealth()

    if (standaloneHealthy) {
      // Connect to existing standalone server
      Logger.info('Connecting to existing standalone Lemonade Server')
      this._usingExistingServer = true
      this._serverUrl = `http://localhost:${this._standalonePort}`
      this._serverName = 'Standalone Lemonade'
      this.client = standaloneClient
      this.setStatus('running')
      vscode.window.showInformationMessage(`Connected to Lemonade Server at http://localhost:${this._standalonePort}`)
      return true
    }

    // No standalone server found, start embedded lemond
    this.client = new LemonadeClient(this._port)

    // Check if the embedded port is in use by something else
    const portInUse = await this.isPortInUse(this._port)
    if (portInUse) {
      vscode.window.showErrorMessage(
        `Port ${this._port} is already in use by another application. `
        + 'Please change the port in settings (lemond.embeddedPort).'
      )
      this.setStatus('error')
      return false
    }

    // Ensure binary is installed
    const installed = await this.binaryManager.ensureBinary()
    if (!installed) {
      this.setStatus('error')
      return false
    }

    this._usingExistingServer = false
    this.setStatus('starting')
    Logger.info(`Starting embedded Lemonade Server on port ${this._port}...`)

    const binaryPath = this.binaryManager.binaryPath
    const workingDir = this.binaryManager.binaryDir

    // Write config.json with the embedded port so lemond uses it.
    // Use default cache directory to avoid Windows permission issues.
    try {
      const configPath = path.join(workingDir, 'config.json')
      const configData = {
        port: this._port
      }
      fs.writeFileSync(configPath, JSON.stringify(configData, null, 2), 'utf8')
      Logger.info(`Wrote config.json with port ${this._port}`)
    } catch (err) {
      Logger.error('Failed to write config.json', err)
    }

    try {
      // lemond [cache_dir] [--port PORT] [--host HOST]
      this.process = spawn(binaryPath, [workingDir, '--port', String(this._port)], {
        cwd: workingDir,
        env: { ...process.env },
        shell: false
      })
    } catch (err) {
      Logger.error('Failed to start server process', err)
      this.setStatus('error')
      vscode.window.showErrorMessage(`Failed to start Lemonade Server: ${err}`)
      return false
    }

    // Handle process output
    this.process.stdout?.on('data', (data: Buffer) => {
      const text = data.toString().trim()
      if (text)
        Logger.info(`[lemond] ${text}`)
    })

    this.process.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim()
      if (text)
        Logger.warn(`[lemond] ${text}`)
    })

    this.process.on('error', (err) => {
      Logger.error('Server process error', err)
      this.setStatus('error')
      vscode.window.showErrorMessage(`Lemonade Server error: ${err.message}`)
    })

    this.process.on('exit', (code, signal) => {
      Logger.info(`Server process exited (code: ${code}, signal: ${signal})`)
      this.process = null
      if (this._status !== 'stopped')
        this.setStatus('stopped')
    })

    // Wait for the server to be ready
    const ready = await this.waitForReady()
    if (ready) {
      this.setStatus('running')
      Logger.info('Lemonade Server is ready')
      vscode.window.showInformationMessage('Lemonade Server started successfully')
      return true
    }
    Logger.error('Server failed to become ready within timeout')
    this.setStatus('error')
    vscode.window.showErrorMessage('Lemonade Server failed to start within 60 seconds. Check the output for details.')
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
      tester.once('error', () => {
        resolve(true)
      })
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
        if (healthy)
          return true
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
      this.setStatus('stopped')
      vscode.window.showInformationMessage('Disconnected from Lemonade Server')
      return
    }

    if (!this.process) {
      Logger.info('Server is not running')
      this.setStatus('stopped')
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
    this.setStatus('stopped')
    Logger.info('Lemonade Server stopped')
    vscode.window.showInformationMessage('Lemonade Server stopped')
  }

  /** Restart the Lemonade Server. */
  async restart(): Promise<boolean> {
    await this.stop()
    await new Promise((resolve) => setTimeout(resolve, 1000))
    return this.start()
  }

  /** Check if the server is running and healthy. */
  async isHealthy(): Promise<boolean> {
    if (this._status !== 'running')
      return false
    try {
      return await this.client.checkHealth()
    } catch {
      return false
    }
  }

  /** Dispose of resources. */
  dispose(): void {
    // Only kill the process if we started it
    if (!this._usingExistingServer && this.process && !this.process.killed)
      this.process.kill('SIGKILL')
    this.process = null
    this._usingExistingServer = false
    this.statusBarItem.dispose()
  }
}
