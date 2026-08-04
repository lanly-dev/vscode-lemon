import * as vscode from 'vscode'
import { Logger } from './logger'
import { BinaryManager } from './binaryManager'
import { ServerManager } from './serverManager'
import { LemonadeClient } from './lemonadeClient'
import { ChatParticipant } from './chatParticipant'
import { ServerViewProvider } from './serverView'

let binaryManager: BinaryManager
let serverManager: ServerManager
let chatParticipant: ChatParticipant
let serverViewProvider: ServerViewProvider

/**
 * Called when the extension is activated.
 */
export function activate(context: vscode.ExtensionContext) {
  Logger.init()
  Logger.info('Lemonade extension is now active')

  // Initialize managers
  binaryManager = new BinaryManager(context)
  serverManager = new ServerManager(context, binaryManager)
  chatParticipant = new ChatParticipant(context, serverManager)
  serverViewProvider = new ServerViewProvider(serverManager, binaryManager)

  // Register the servers view
  const serversView = vscode.window.registerTreeDataProvider(
    'lemond.serversView',
    serverViewProvider
  )
  context.subscriptions.push(serversView)

  // Register commands
  registerCommands(context)

  // Check for auto-start
  const config = vscode.workspace.getConfiguration('lemond')
  const autoStart = config.get<boolean>('autoStart', false)
  if (autoStart) {
    Logger.info('Auto-start is enabled, starting server...')
    serverManager.start().catch((err: unknown) => {
      Logger.error('Auto-start failed', err)
    })
  }

  // Check for updates in the background
  binaryManager.checkForUpdates().catch((err: unknown) => {
    Logger.error('Update check failed', err)
  })
}

/**
 * Register all extension commands.
 */
function registerCommands(context: vscode.ExtensionContext): void {
  // Start server
  context.subscriptions.push(
    vscode.commands.registerCommand('lemond.startServer', async () => {
      await serverManager.start()
      serverViewProvider.refresh()
    })
  )

  // Stop server
  context.subscriptions.push(
    vscode.commands.registerCommand('lemond.stopServer', async () => {
      await serverManager.stop()
      serverViewProvider.refresh()
    })
  )

  // Restart server
  context.subscriptions.push(
    vscode.commands.registerCommand('lemond.restartServer', async () => {
      await serverManager.restart()
      serverViewProvider.refresh()
    })
  )

  // Download binary
  context.subscriptions.push(
    vscode.commands.registerCommand('lemond.downloadBinary', async () => {
      try {
        await binaryManager.downloadBinary()
        vscode.window.showInformationMessage('Lemonade Server binary downloaded successfully')
      } catch (err: unknown) {
        Logger.error('Failed to download binary', err)
        vscode.window.showErrorMessage(`Failed to download binary: ${err}`)
      }
    })
  )

  // Open chat
  context.subscriptions.push(
    vscode.commands.registerCommand('lemond.openChat', async () => {
      await ChatParticipant.openChat()
    })
  )

  // Pull model
  context.subscriptions.push(
    vscode.commands.registerCommand('lemond.pullModel', async () => {
      if (serverManager.status !== 'running') {
        const start = await vscode.window.showInformationMessage(
          'Lemonade Server is not running. Start it now?',
          'Start Server',
          'Cancel'
        )
        if (start !== 'Start Server')
          return
        const started = await serverManager.start()
        if (!started)
          return
      }

      const modelName = await vscode.window.showInputBox({
        title: 'Pull Model',
        prompt: 'Enter the model name to download (e.g., Qwen3-0.6B-GGUF)',
        placeHolder: 'Model name'
      })

      if (!modelName)
        return

      const client = new LemonadeClient(0)
      client.setBaseUrl(serverManager.selectedServerUrl)
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Pulling model: ${modelName}`,
          cancellable: false
        },
        async (progress) => {
          progress.report({ message: 'Downloading model...' })
          try {
            await client.pullModel(modelName, (msg: string) => {
              progress.report({ message: msg })
            })
            vscode.window.showInformationMessage(`Model '${modelName}' pulled successfully`)
            serverViewProvider.refresh()
          } catch (err: unknown) {
            Logger.error('Failed to pull model', err)
            vscode.window.showErrorMessage(`Failed to pull model: ${err}`)
          }
        }
      )
    })
  )

  // Load model
  context.subscriptions.push(
    vscode.commands.registerCommand('lemond.loadModel', async (item?: { modelId?: string }) => {
      if (serverManager.status !== 'running') {
        vscode.window.showErrorMessage('Lemonade Server is not running')
        return
      }

      const client = new LemonadeClient(0)
      client.setBaseUrl(serverManager.selectedServerUrl)
      let modelName = item?.modelId

      if (!modelName) {
        try {
          const models = await client.listModels()
          if (models.length === 0) {
            vscode.window.showWarningMessage('No models available. Pull a model first.')
            return
          }
          const items: vscode.QuickPickItem[] = models.map((m) => ({
            label: m.id,
            description: m.owned_by ?? ''
          }))
          const selected = await vscode.window.showQuickPick(items, {
            title: 'Select a model to load',
            placeHolder: 'Choose a model'
          })
          if (!selected)
            return
          modelName = selected.label
        } catch (err: unknown) {
          Logger.error('Failed to list models', err)
          vscode.window.showErrorMessage(`Failed to list models: ${err}`)
          return
        }
      }

      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Loading model: ${modelName}`,
            cancellable: false
          },
          async () => {
            await client.loadModel(modelName!)
          }
        )
        vscode.window.showInformationMessage(`Model '${modelName}' loaded successfully`)
        chatParticipant.setSelectedModel(modelName)
        serverViewProvider.refresh()
      } catch (err: unknown) {
        Logger.error('Failed to load model', err)
        vscode.window.showErrorMessage(`Failed to load model: ${err}`)
      }
    })
  )

  // Unload model
  context.subscriptions.push(
    vscode.commands.registerCommand('lemond.unloadModel', async (item?: { modelId?: string }) => {
      if (serverManager.status !== 'running') {
        vscode.window.showErrorMessage('Lemonade Server is not running')
        return
      }

      const client = new LemonadeClient(0)
      client.setBaseUrl(serverManager.selectedServerUrl)
      let modelName = item?.modelId

      if (!modelName) {
        try {
          const health = await client.getHealth()
          const loadedModels = health.all_models_loaded.map((m) => m.model_name)
          if (loadedModels.length === 0) {
            vscode.window.showInformationMessage('No models are currently loaded')
            return
          }
          const items: vscode.QuickPickItem[] = loadedModels.map((m) => ({ label: m }))
          const selected = await vscode.window.showQuickPick(items, {
            title: 'Select a model to unload',
            placeHolder: 'Choose a model'
          })
          if (!selected)
            return
          modelName = selected.label
        } catch (err: unknown) {
          Logger.error('Failed to get loaded models', err)
          vscode.window.showErrorMessage(`Failed to get loaded models: ${err}`)
          return
        }
      }

      try {
        await client.unloadModel(modelName)
        vscode.window.showInformationMessage(`Model '${modelName}' unloaded successfully`)
        serverViewProvider.refresh()
      } catch (err: unknown) {
        Logger.error('Failed to unload model', err)
        vscode.window.showErrorMessage(`Failed to unload model: ${err}`)
      }
    })
  )

  // Select model for chat
  context.subscriptions.push(
    vscode.commands.registerCommand('lemond.selectModel', async () => {
      if (serverManager.status !== 'running') {
        vscode.window.showErrorMessage('Lemonade Server is not running')
        return
      }

      const client = new LemonadeClient(0)
      client.setBaseUrl(serverManager.selectedServerUrl)
      try {
        const models = await client.listModels()
        if (models.length === 0) {
          vscode.window.showWarningMessage('No models available. Pull a model first.')
          return
        }
        const items: vscode.QuickPickItem[] = models.map((m) => ({
          label: m.id,
          description: m.owned_by ?? ''
        }))
        const selected = await vscode.window.showQuickPick(items, {
          title: 'Select active model for chat',
          placeHolder: 'Choose a model'
        })
        if (selected) {
          chatParticipant.setSelectedModel(selected.label)
          vscode.window.showInformationMessage(`Selected model: ${selected.label}`)
        }
      } catch (err: unknown) {
        Logger.error('Failed to select model', err)
        vscode.window.showErrorMessage(`Failed to select model: ${err}`)
      }
    })
  )

  // Refresh server status
  context.subscriptions.push(
    vscode.commands.registerCommand('lemond.refreshServer', () => {
      serverViewProvider.refresh()
    })
  )
}

/**
 * Called when the extension is deactivated.
 */
export function deactivate() {
  if (serverManager)
    serverManager.dispose()
  Logger.info('Lemonade extension deactivated')
}
