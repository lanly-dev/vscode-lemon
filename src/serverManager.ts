import { ChildProcess, exec, spawn } from 'child_process'
import { promisify } from 'util'
const execAsync = promisify(exec)

import * as fs from 'fs'
import * as path from 'path'

import { ConfigurationTarget, Disposable, QuickPickItem, WorkspaceConfiguration } from 'vscode'
import { window, workspace } from 'vscode'
const { showErrorMessage, showInformationMessage, showInputBox, showQuickPick } = window

import { BinaryManager } from './binaryManager'
import { LemonadeClient } from './lemonadeClient'
import { Logger } from './logger'
import { refreshEvents } from './events'
import { ServerStatus, ServerMode, type LemonadeModel, type ServerInstance } from './interfaces'

// Manages the Lemonade Server process lifecycle.
export class ServerManager {
  private _lemondPort: number = 8000
  private _lemonadePort: number = 13305

  private _serverName: string = ''
  private _serverUrl: string = ''
  private _status: ServerStatus = ServerStatus.STOPPED
  private _usingExistingServer = false

  private _client?: LemonadeClient
  private _fatalErrorShown = false
  private _processExited = false
  private _lastAppliedMode: ServerMode = ServerMode.LEMONADE

  private process: ChildProcess | null = null
  private activeServerChangeCallbacks: Array<() => void> = []
  private statusChangeCallbacks: Array<(status: ServerStatus) => void> = []

  constructor(private binaryManager: BinaryManager) {
    void this.applyConfiguredServerMode()
  }

  /** Get the current server status. */
  get status(): ServerStatus {
    return this._status
  }

  /** Get the lemond binary port. */
  get lemondPort(): number {
    return this._lemondPort
  }

  /** Get the Lemonade Server port. */
  get lemonadePort(): number {
    return this._lemonadePort
  }

  /** Get the URL of the configured target server (mode-aware). */
  get url(): string {
    const config = workspace.getConfiguration('chanh')
    const mode = config.get<ServerMode>('serverMode', ServerMode.LEMONADE)
    if (mode === ServerMode.LEMOND) return this.lemondUrl
    if (mode === ServerMode.CUSTOM) {
      const customUrl = config.get<string>('customServerUrl', '').trim()
      if (customUrl) return customUrl
      return ''
    }
    if (mode === ServerMode.LEMONADE) return `http://localhost:${this._lemonadePort}`
    return ''
  }

  /** Get the URL of the lemond binary server, regardless of the selected mode. */
  get lemondUrl(): string {
    return `http://localhost:${this._lemondPort}`
  }

  /** Get the currently active server URL for chat. */
  get activeServerUrl(): string {
    if (this._serverUrl) return this._serverUrl
    return this.url
  }

  /** Get the name of the currently active server. */
  get activeServerName(): string {
    if (this._serverName) return this._serverName
    return 'Missing Active Server'
  }

  /** Get whether the lemond server is selected. */
  get isLemondActive(): boolean {
    return this.activeServerUrl === this.lemondUrl
  }

  /** A client bound to the currently active server for model operations. */
  get client(): LemonadeClient {
    if (!this._client) throw new Error('Model client is not initialized.')
    this._client.setBaseUrl(this.activeServerUrl)
    return this._client
  }

  /** Apply the configured `chanh.serverMode` to the in-memory server selection. */
  async applyConfiguredServerMode(): Promise<void> {
    const config = workspace.getConfiguration('chanh')
    const mode = config.get<ServerMode>('serverMode', ServerMode.LEMONADE)
    this._lemonadePort = config.get<number>('lemonadePort', 13305)
    this._lemondPort = config.get<number>('lemondPort', 8000)
    this._lastAppliedMode = mode

    switch (mode) {
      case ServerMode.LEMONADE: {
        const url = `http://localhost:${this._lemonadePort}`
        this._client = new LemonadeClient(url)
        this.setActiveServer(url, 'Lemonade Server (System)')
        // Probe the Lemonade Server (System) to determine actual status
        await this.refreshStatus()
        break
      }
      case ServerMode.LEMOND: {
        const url = `http://localhost:${this._lemondPort}`
        this._client = new LemonadeClient(url)
        this.setActiveServer(url, 'lemond (Binary)')
        // Check if a lemond server is already running at this port
        await this.refreshStatus()
        break
      }
      case ServerMode.CUSTOM: {
        const url = config.get<string>('customServerUrl', '').trim()
        if (url) {
          this._client = new LemonadeClient(url)
          this.setActiveServer(url, 'Custom Server')
          await this.refreshStatus()
        } else showErrorMessage('Chanh: CUSTOM server mode requires chanh.customServerUrl.')
        break
      }
      default: {
        showErrorMessage(`Chanh: unknown chanh.serverMode "${mode}".`)
        break
      }
    }
  }

  /**
   * Fetch status for the currently selected target server and reflect it onto
   * this._status. Returns the active ServerInstance for display (or null if
   * none is configured, e.g. custom mode with no URL).
   */
  async getActiveServer(): Promise<ServerInstance | null> {
    const config = workspace.getConfiguration('chanh')
    const mode = config.get<ServerMode>('serverMode')

    let instance: ServerInstance | null
    switch (mode) {
      case ServerMode.LEMOND:
        instance = await this.fetchLemondServer(config)
        break
      case ServerMode.CUSTOM:
        if (config.get<string>('customServerUrl', '').trim()) instance = await this.fetchCustomServer(config)
        else instance = null
        break
      case ServerMode.LEMONADE:
        instance = await this.fetchLemonadeServer(config)
        break
      default:
        instance = null
        break
    }

    // Reflect the active server's status onto the manager.
    if (instance) this.setStatus(instance.status)
    return instance
  }

  /** Fetch the Lemonade server status. */
  private async fetchLemonadeServer(config: WorkspaceConfiguration): Promise<ServerInstance | null> {
    const lemonadePort = config.get<number>('lemonadePort', 13305)
    const client = new LemonadeClient(`http://localhost:${lemonadePort}`)
    try {
      const health = await client.getHealth()
      const { models, downloadableModels } = await this.fetchAllCatalogModels(client)
      return {
        id: ServerMode.LEMONADE,
        name: 'Lemonade Server (System)',
        url: `http://localhost:${lemonadePort}`,
        status: ServerStatus.RUNNING,
        health,
        models,
        downloadableModels,
        maxLoadedModels: health.max_loaded_models
      }
    } catch {
      return {
        id: ServerMode.LEMONADE,
        name: 'Lemonade Server (System)',
        url: `http://localhost:${lemonadePort}`,
        status: ServerStatus.ERROR
      }
    }
  }

  /** Fetch the custom Lemonade server status. */
  private async fetchCustomServer(config: WorkspaceConfiguration): Promise<ServerInstance | null> {
    const customUrl = config.get<string>('customServerUrl', '')
    if (!customUrl) {
      return {
        id: ServerMode.CUSTOM,
        name: 'Custom Server',
        url: '',
        status: ServerStatus.ERROR,
        error: 'No URL configured. Click to enter a server URL.'
      }
    }
    const client = new LemonadeClient(customUrl)
    try {
      const health = await client.getHealth()
      const { models, downloadableModels } = await this.fetchAllCatalogModels(client)
      return {
        id: ServerMode.CUSTOM,
        name: 'Custom Server',
        url: customUrl,
        status: ServerStatus.RUNNING,
        health,
        models,
        downloadableModels,
        maxLoadedModels: health.max_loaded_models
      }
    } catch (err) {
      return {
        id: ServerMode.CUSTOM,
        name: 'Custom Server',
        url: customUrl,
        status: ServerStatus.ERROR,
        error: `Unreachable: ${err instanceof Error ? err.message : String(err)}. Click to enter a new URL.`
      }
    }
  }

  /** Split the full catalog (?show_all=true) into downloaded vs downloadable models. */
  private async fetchAllCatalogModels(client: LemonadeClient):
    Promise<{ models: LemonadeModel[], downloadableModels: LemonadeModel[] }> {
    try {
      const all = await client.listModels(true)
      return {
        models: all.filter((m) => m.downloaded !== false),
        downloadableModels: all.filter((m) => m.downloaded === false)
      }
    } catch {
      // Older servers may not support ?show_all=true — fall back to downloaded only.
      const models = await client.listModels()
      return { models, downloadableModels: [] }
    }
  }

  /** Fetch the lemond server status. */
  private async fetchLemondServer(config: WorkspaceConfiguration): Promise<ServerInstance | null> {
    const lemondClient = new LemonadeClient(this.lemondUrl)

    // First, do a non-throwing health check to determine if the server is reachable.
    const isHealthy = await lemondClient.checkHealth()
    if (!isHealthy) {
      // Server is not responding — return stopped status since we probed and
      // confirmed it's not reachable. This is based on the health check result,
      // not an assumption about failure mode.
      return {
        id: ServerMode.LEMOND,
        name: 'lemond (Managed by Chanh)',
        url: this.lemondUrl,
        status: ServerStatus.STOPPED,
        version: this.binaryManager.getInstalledVersion() ?? undefined,
        maxLoadedModels: config.get<number>('maxLoadedModels', 1)
      }
    }

    // Server is healthy — fetch full details
    const health = await lemondClient.getHealth()
    const { models, downloadableModels } = await this.fetchAllCatalogModels(lemondClient)
    let maxLoadedModels = config.get<number>('maxLoadedModels', 1)

    // If the server reports its max_loaded_models, keep the extension config in sync
    if (typeof health.max_loaded_models === 'number' && Number.isInteger(health.max_loaded_models)) {
      maxLoadedModels = health.max_loaded_models
      if (config.get<number>('maxLoadedModels', 1) !== maxLoadedModels) {
        await config.update('maxLoadedModels', maxLoadedModels, ConfigurationTarget.Global)
        Logger.info(`Synced chanh.maxLoadedModels from server to ${maxLoadedModels}`)
      }
    }

    return {
      id: ServerMode.LEMOND,
      name: 'lemond (Managed by Chanh)',
      url: this.lemondUrl,
      status: ServerStatus.RUNNING,
      version: this.binaryManager.getInstalledVersion() ?? undefined,
      health,
      models,
      downloadableModels,
      maxLoadedModels
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

  /** Set the active server for chat and notify listeners (e.g. the chat participant). */
  setActiveServer(url: string, name: string): void {
    this._serverUrl = url
    this._serverName = name
    Logger.info(`Active server: ${name} (${url})`)
    for (const callback of this.activeServerChangeCallbacks) callback()
  }

  /** Register a callback invoked whenever the active chat server changes. */
  onActiveServerChange(callback: () => void): Disposable {
    this.activeServerChangeCallbacks.push(callback)
    return new Disposable(() => {
      const index = this.activeServerChangeCallbacks.indexOf(callback)
      if (index >= 0) this.activeServerChangeCallbacks.splice(index, 1)
    })
  }

  /** Probe the currently active server and update status accordingly. */
  private async refreshStatus(): Promise<void> {
    try {
      const instance = await this.getActiveServer()
      if (instance) {
        this.setStatus(instance.status)
        Logger.info(`Server status after mode switch: ${instance.status} (${instance.name})`)
      } else {
        // getActiveServer returned null (e.g., custom server unreachable)
        this.setStatus(ServerStatus.STOPPED)
      }
    } catch (err) {
      Logger.warn(`Could not determine server status after mode switch: ${err}`)
      this.setStatus(ServerStatus.STOPPED)
    }
  }

  async switchServer(): Promise<void> {
    await this.switchServerHelper()
    refreshEvents.fire()
  }

  /** Switch the active server */
  private async switchServerHelper(): Promise<void> {
    const config = workspace.getConfiguration('chanh')
    const lemonadePort = config.get<number>('lemonadePort', 13305)
    const lemondPort = config.get<number>('lemondPort', 8000)
    const lemonadeUrl = `http://localhost:${lemonadePort}`
    const lemondUrl = `http://localhost:${lemondPort}`
    let defaultUrl = config.get<string>('customServerUrl', '')

    const mode = config.get<ServerMode>('serverMode', ServerMode.LEMONADE)
    const items: QuickPickItem[] = []

    if (mode !== ServerMode.LEMONADE) {
      items.push({
        label: `$(server) Lemonade Server (System)`,
        description: lemonadeUrl,
        detail: 'Existing system install, extension only connects (port chanh.lemonadePort)'
      })
    }

    if (mode !== ServerMode.LEMOND) {
      items.push({
        label: `$(server-process) lemond (Managed by Chanh)`,
        description: lemondUrl,
        detail: `Bundled binary in globalStorage, extension manages lifecycle (port chanh.lemondPort)`
      })
    }

    if (mode !== ServerMode.CUSTOM) {
      items.push({
        label: `$(globe) Custom Server`,
        description: defaultUrl,
        detail: 'A user-configured Lemonade Server URL'
      })
    }

    const selected = await showQuickPick(items, {
      title: 'Select Lemonade Server',
      placeHolder: 'Choose which Lemonade Server to use'
    })

    if (!selected) return

    // Select the chosen server
    if (selected.label.includes('Lemonade')) {
      await config.update('serverMode', ServerMode.LEMONADE, ConfigurationTarget.Global)
      this.setActiveServer(lemonadeUrl, 'Lemonade Server (System)')
    } else if (selected.label.includes('lemond')) {
      await config.update('serverMode', ServerMode.LEMOND, ConfigurationTarget.Global)
      this.setActiveServer(lemondUrl, 'lemond (Binary)')
    } else {
      if (!defaultUrl) {
        const url = await showInputBox({
          title: 'Custom Server URL',
          prompt: 'Enter the Lemonade Server URL (e.g., http://localhost:13305)',
          placeHolder: 'http://localhost:13305',
          value: defaultUrl,
          validateInput: (input) => {
            const trimmed = input.trim()
            if (!trimmed) return 'Please enter a URL'
            if (!/^https?:\/\//i.test(trimmed)) return 'URL must start with http:// or https://'
            return undefined
          }
        })
        if (!url) return
        defaultUrl = url.trim()
      }
      if (!defaultUrl) return
      // Save to config and select
      await config.update('serverMode', ServerMode.CUSTOM, ConfigurationTarget.Global)
      await config.update('customServerUrl', defaultUrl, ConfigurationTarget.Global)
      this.setActiveServer(defaultUrl, 'Custom Server')
    }
  }

  /**
   * Edit the active server's port (lemonade/lemond) or custom URL.
   * Persists the change to config; the mode re-application and tree refresh are
   * handled by the onDidChangeConfiguration listener + a manual refresh.
   */
  async editServerPort(): Promise<void> {
    const config = workspace.getConfiguration('chanh')
    const mode = config.get<ServerMode>('serverMode', ServerMode.LEMONADE)

    // Custom mode edits the URL; lemonade/lemond edit the port.
    if (mode === ServerMode.CUSTOM) {
      const current = config.get<string>('customServerUrl', '') || 'http://localhost:13305'
      const url = await showInputBox({
        title: 'Custom Server URL',
        prompt: 'Enter the Lemonade Server URL (e.g., http://localhost:13305)',
        placeHolder: 'http://localhost:13305',
        value: current,
        validateInput: (input) => {
          const trimmed = input.trim()
          if (!trimmed) return 'Please enter a URL'
          if (!/^https?:\/\//i.test(trimmed)) return 'URL must start with http:// or https://'
          return undefined
        }
      })
      if (url === undefined || url.trim() === '') return
      await config.update('customServerUrl', url.trim(), ConfigurationTarget.Global)
      showInformationMessage(`Custom server URL updated to ${url.trim()}`)
    } else {
      const isLemond = mode === ServerMode.LEMOND
      const key = isLemond ? 'lemondPort' : 'lemonadePort'
      const current = config.get<number>(key, isLemond ? 8000 : 13305)

      const value = await showInputBox({
        title: isLemond ? 'LEMOND Port' : 'Lemonade Server (System) Port',
        prompt: `Current: ${current}. Enter the port for the ` +
          `${isLemond ? 'LEMOND' : 'Lemonade Server'}.`,
        value: String(current),
        validateInput: (input) => {
          const trimmed = input.trim()
          if (!trimmed) return 'Please enter a port number'
          const n = Number(trimmed)
          if (!Number.isInteger(n) || n < 1 || n > 65535) return 'Enter a valid port (1-65535)'
          return undefined
        }
      })
      if (value === undefined || value.trim() === '') return
      const port = Number(value.trim())
      await config.update(key, port, ConfigurationTarget.Global)
      showInformationMessage(
        `${isLemond ? 'LEMOND' : 'LEMONADE'} port updated to ${port}`
      )
    }

    // applyConfiguredServerMode + refresh are handled onDidChangeConfiguration,
    // but refresh explicitly so the new URL/port is reflected immediately.
    refreshEvents.fire()
  }

  /** Register a callback for status changes. */
  onStatusChange(callback: (status: ServerStatus) => void): Disposable {
    this.statusChangeCallbacks.push(callback)
    return new Disposable(() => {
      const index = this.statusChangeCallbacks.indexOf(callback)
      if (index >= 0) this.statusChangeCallbacks.splice(index, 1)
    })
  }

  /** Update the status and notify callbacks (only on an actual change). */
  private setStatus(status: ServerStatus): void {
    if (this._status === status) return
    this._status = status
    for (const callback of this.statusChangeCallbacks) callback(status)
  }


  /** Start the Lemonade Server. */
  // TODO: double check, logic doesn't quite right
  async start(): Promise<boolean> {
    const config = workspace.getConfiguration('chanh')
    const serverMode = config.get<ServerMode>('serverMode', ServerMode.LEMONADE)

    if (serverMode !== ServerMode.LEMOND) {
      showInformationMessage('Chanh can only start or stop the managed lemond server in LEMOND mode.')
      return false
    }

    if (this._status === ServerStatus.RUNNING || this._status === ServerStatus.STARTING) {
      Logger.warn('Server is already running or starting')
      showInformationMessage('Lemonade Server is already running')
      return true
    }

    this._lemondPort = config.get<number>('lemondPort', 8000)

    // Lemond mode: always start the lemond binary.
    this.setActiveServer(this.lemondUrl, 'lemond (Managed by Chanh)')

    // No lemonade server found (or lemond mode forced), start lemond
    this._client = new LemonadeClient(`http://localhost:${this._lemondPort}`)

    // Check if the lemond port is in use by something else
    const portInUse = await this.isPortInUse(this._lemondPort)
    if (portInUse) {
      // Identify which process owns the port so we can decide how to handle it.
      const ownerPaths = await this.getListeningProcessPaths(this._lemondPort)
      const ownBinary = path.resolve(this.binaryManager.binaryPath)
      const isOwnBinary = ownerPaths.some((p) => this.pathsEqual(p, ownBinary))

      if (isOwnBinary) {
        // It's the extension's own lemond binary already running on this port.
        // Reconnect to it instead of trying to start a duplicate.
        Logger.info(
          `Found the extension's own lemond binary already listening on port ${this._lemondPort}; connecting to it.`
        )
        this._usingExistingServer = true
        this._client = new LemonadeClient(`http://localhost:${this._lemondPort}`)
        this.setActiveServer(`http://localhost:${this._lemondPort}`, 'lemond (Binary)')
        this.setStatus(ServerStatus.RUNNING)
        showInformationMessage(
          `Connected to existing lemond binary at http://localhost:${this._lemondPort}`
        )

        refreshEvents.fire()
        return true
      }

      const owner = ownerPaths.length
        ? ownerPaths.join(', ')
        : `unknown process (PID available via netstat port ${this._lemondPort})`
      showInformationMessage(
        `Port ${this._lemondPort} is already in use by: ${owner}. ` +
        'If this is your own Lemonade server, connect to it via chanh.serverMode ' +
        'instead of starting a new lemond binary, or change chanh.lemondPort.'
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
    Logger.info(`Starting lemond binary on port ${this._lemondPort}...`)

    const binaryPath = this.binaryManager.binaryPath
    const workingDir = this.binaryManager.binaryDir

    // Write config.json with the lemond port so lemond uses it.
    // Use default cache directory to avoid Windows permission issues.
    try {
      const configPath = path.join(workingDir, 'config.json')
      const config = workspace.getConfiguration('chanh')
      const maxLoadedModels = config.get<number>('maxLoadedModels', 1)
      const configData = {
        port: this._lemondPort,
        max_loaded_models: maxLoadedModels
      }
      fs.writeFileSync(configPath, JSON.stringify(configData, null, 2), 'utf8')
      Logger.info(`Wrote config.json with port ${this._lemondPort} and max_loaded_models ${maxLoadedModels}`)
    } catch (err) {
      Logger.error('Failed to write config.json', err)
    }

    try {
      // lemond [cache_dir] [--port PORT] [--host HOST]
      this.process = spawn(binaryPath, [workingDir, '--port', String(this._lemondPort)], {
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
    this._fatalErrorShown = false
    this._processExited = false
    this.process.stdout?.on('data', (data: Buffer) => {
      const text = data.toString().trim()
      if (text) Logger.info(`[chanh] ${text}`)
    })

    this.process.stderr?.on('data', (data: Buffer) => {
      const text = data.toString().trim()
      if (!text) return
      Logger.warn(`[chanh] ${text}`)
      // The lemond process reports a fatal startup error (e.g. port already
      // in use) through its own logs. Surface it to the user as an error popup.
      if (!this._fatalErrorShown && /already in use|ERROR|will now exit/i.test(text)) {
        this._fatalErrorShown = true
        showErrorMessage(`Lemonade Server failed to start: ${text}`)
      }
    })

    this.process.on('error', (err) => {
      Logger.error('Server process error', err)
      this.setStatus(ServerStatus.ERROR)
      showErrorMessage(`Lemonade Server error: ${err.message}`)
    })

    this.process.on('exit', (code, signal) => {
      Logger.info(`Server process exited (code: ${code}, signal: ${signal})`)
      this.process = null
      this._processExited = true
      if (this._status !== ServerStatus.STOPPED) this.setStatus(ServerStatus.STOPPED)
    })

    // Wait for the server to be ready
    const ready = await this.waitForReady()
    if (ready) {
      this.setActiveServer(`http://localhost:${this._lemondPort}`, 'lemond (Binary)')
      this.setStatus(ServerStatus.RUNNING)
      Logger.info('lemond binary is ready')
      showInformationMessage('lemond binary started successfully')
      refreshEvents.fire()
      return true
    }

    // The process exited before becoming ready. The real cause (e.g. port
    // already in use) was already reported, so skip the misleading timeout.
    if (this._processExited) {
      Logger.info('Server process exited before becoming ready; skipping timeout wait.')
      this.setStatus(ServerStatus.ERROR)
      return false
    }

    Logger.error('Server failed to become ready within timeout')
    this.setStatus(ServerStatus.ERROR)
    showErrorMessage('Lemonade Server failed to start within 60 seconds. Check the output for details.')
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

  /**
   * Enumerate the executable paths of processes listening on the given port.
   * Returns an empty array if the port is free or ownership cannot be resolved.
   */
  private async getListeningProcessPaths(port: number): Promise<string[]> {
    const paths: string[] = []
    try {
      if (process.platform === 'win32') {
        // Base64-encode the script to avoid PowerShell/cmd quoting pitfalls.
        const script = [
          `$pids = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue ` +
          `| Select-Object -ExpandProperty OwningProcess -Unique;`,
          `$paths = @();`,
          `foreach ($id in $pids) {`,
          `  $pr = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $id) -ErrorAction SilentlyContinue;`,
          `  if ($pr -and $pr.ExecutablePath) { $paths += $pr.ExecutablePath }`,
          `};`,
          `$paths`
        ].join(' ')
        const encoded = Buffer.from(script, 'utf16le').toString('base64')
        const { stdout } = await execAsync(
          `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`,
          { timeout: 15000 }
        )
        paths.push(...stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean))
      } else {
        // Linux / macOS: find the PIDs listening on the port.
        const { stdout } = await execAsync(
          `lsof -nP -t -iTCP:${port} -sTCP:LISTEN`,
          { timeout: 15000 }
        )
        for (const rawPid of stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
          const pid = parseInt(rawPid, 10)
          if (!pid) continue
          try {
            if (process.platform === 'linux') {
              // Resolve the owning executable through /proc (handles symlinks).
              paths.push(fs.realpathSync(`/proc/${pid}/exe`))
            } else {
              // macOS: lsof reports the executable file descriptor.
              const { stdout: exeOut } = await execAsync(
                `lsof -a -d txt -nP -Fn -p ${pid}`,
                { timeout: 10000 }
              )
              const match = exeOut.split(/\r?\n/).find((l) => l.startsWith('n'))
              if (match) paths.push(match.slice(1))
            }
          } catch {
            // PID disappeared or permissions denied; skip.
          }
        }
      }
    } catch {
      Logger.warn(`Could not enumerate the process owning port ${port}`)
    }
    return paths
  }

  /** Compare two executable paths, ignoring platform-specific case differences. */
  private pathsEqual(a: string, b: string): boolean {
    const na = path.resolve(a)
    const nb = path.resolve(b)
    return process.platform === 'win32'
      ? na.toLowerCase() === nb.toLowerCase()
      : na === nb
  }

  /** Wait for the server to respond to health checks. */
  private async waitForReady(timeoutMs: number = 60000): Promise<boolean> {
    const startTime = Date.now()
    const checkInterval = 1000

    while (!this._processExited && Date.now() - startTime < timeoutMs) {
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

  /** Stop the managed lemond process. */
  async stop(): Promise<void> {
    const mode = workspace.getConfiguration('chanh').get<ServerMode>('serverMode', ServerMode.LEMONADE)
    if (mode !== ServerMode.LEMOND) {
      showInformationMessage('Chanh can only start or stop the managed lemond server in LEMOND mode.')
      return
    }
    await this.stopManagedLemond()
  }

  /** Whether the most recently applied configuration used the given mode. */
  wasLastAppliedMode(mode: ServerMode): boolean {
    return this._lastAppliedMode === mode
  }

  /** Stop the managed lemond process after a mode transition. */
  async stopManagedLemond(): Promise<void> {
    // If using an existing server, just disconnect
    if (this._usingExistingServer) {
      Logger.info('Disconnecting from existing Lemonade Server')
      this._usingExistingServer = false
      this.setStatus(ServerStatus.STOPPED)
      showInformationMessage('Disconnected from Lemonade Server')
      refreshEvents.fire()
      return
    }

    if (!this.process) {
      Logger.info('Server is not running')
      this.setStatus(ServerStatus.STOPPED)
      refreshEvents.fire()
      return
    }

    Logger.info('Stopping Lemonade Server...')

    // Try graceful shutdown via API
    try {
      await this.client.unloadAllModels()
    } catch {
      Logger.warn('Failed to unload all models before stopping the server')
      // Ignore errors, we're shutting down anyway
    }

    // Ask the child to terminate, then force-kill it if it has not exited.
    // ChildProcess.killed only means a signal was successfully sent; it does
    // not tell us whether the process has actually exited.
    const serverProcess = this.process
    serverProcess.kill('SIGTERM')

    await new Promise((resolve) => setTimeout(resolve, 2000))
    if (!this._processExited && this.process === serverProcess) {
      Logger.warn('Server did not exit after SIGTERM, sending SIGKILL')
      serverProcess.kill('SIGKILL')
    }

    this.process = null
    this.setStatus(ServerStatus.STOPPED)
    Logger.info('Lemonade Server stopped')
    refreshEvents.fire()
    showInformationMessage('Lemonade Server stopped')
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
    this.activeServerChangeCallbacks = []
    this.statusChangeCallbacks = []
    // Only kill the process if we started it
    if (!this._usingExistingServer && this.process && !this.process.killed) this.process.kill('SIGKILL')
    this.process = null
    this._usingExistingServer = false
  }
}

/** React to configuration changes that affect which server is targeted. */
export function listenConfigsChange(serverManager: ServerManager) {
  return workspace.onDidChangeConfiguration(async (e) => {
    const settings = ['chanh.serverMode', 'chanh.customServerUrl', 'chanh.lemonadePort', 'chanh.lemondPort']

    if (settings.some((setting) => e.affectsConfiguration(setting))) {
      const config = workspace.getConfiguration('chanh')
      const newMode = config.get<ServerMode>('serverMode', ServerMode.LEMONADE)

      // Stop only on an actual LEMOND -> non-LEMOND transition, before the
      // active client is re-pointed at the newly configured server.
      if (serverManager.wasLastAppliedMode(ServerMode.LEMOND) && newMode !== ServerMode.LEMOND) {
        await serverManager.stopManagedLemond()
      }

      await serverManager.applyConfiguredServerMode()
      refreshEvents.fire()
    }
  })
}
