import * as vscode from 'vscode'
import { BinaryManager } from './binaryManager'
import { ChatParticipant } from './chatParticipant'
import { LemonadeClient } from './lemonadeClient'
import { Logger } from './logger'
import { ServerManager } from './serverManager'
import { ServerStatus } from './interfaces'
import { ServerViewProvider } from './serverTreeview'

export async function activate(context: vscode.ExtensionContext) {
  const rc = vscode.commands.registerCommand

  // Initialize managers
  const binaryManager = new BinaryManager(context)
  const serverManager = new ServerManager(context, binaryManager)
  const chatParticipant = new ChatParticipant(context, serverManager)
  const provider = await createTreeView(serverManager, binaryManager)

  const d1 = rc('lemon.startServer', async () => {
    await serverManager.start()
    provider.refresh()
  })

  const d2 = rc('lemon.stopServer', async () => {
    await serverManager.stop()
    provider.refresh()
  })

  const d3 = rc('lemon.restartServer', async () => {
    await serverManager.restart()
    provider.refresh()
  })

  const d4 = rc('lemon.downloadBinary', async () => {
    try {
      await binaryManager.downloadBinary()
      vscode.window.showInformationMessage('Lemonade Server binary downloaded successfully')
    } catch (err: unknown) {
      Logger.error('Failed to download binary', err)
      vscode.window.showErrorMessage(`Failed to download binary: ${err}`)
    }
  })

  const d5 = rc('lemon.openChat', () => ChatParticipant.openChat())

  const d6 = rc('lemon.openSettings', () => {
    vscode.commands.executeCommand('workbench.action.openSettings', '@ext:lanly-dev.lemon')
  })

  const d7 = rc('lemon.pullModel', async () => {
    if (serverManager.status !== ServerStatus.RUNNING) {
      const start = await vscode.window.showInformationMessage(
        'Lemonade Server is not running. Start it now?',
        'Start Server',
        'Cancel'
      )
      if (start !== 'Start Server') return
      const started = await serverManager.start()
      if (!started) return
    }

    const modelName = await vscode.window.showInputBox({
      title: 'Pull Model',
      prompt: 'Enter the model name to download (e.g., Qwen3-0.6B-GGUF)',
      placeHolder: 'Model name'
    })

    if (!modelName) return

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
          provider.refresh()
        } catch (err: unknown) {
          Logger.error('Failed to pull model', err)
          vscode.window.showErrorMessage(`Failed to pull model: ${err}`)
        }
      }
    )
  })

  const d8 = rc('lemon.loadModel', async (item?: { modelId?: string }) => {
    if (serverManager.status !== ServerStatus.RUNNING) {
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
        if (!selected) return
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
      provider.refresh()
    } catch (err: unknown) {
      Logger.error('Failed to load model', err)
      vscode.window.showErrorMessage(`Failed to load model: ${err}`)
    }
  })

  const d9 = rc('lemon.unloadModel', async (item?: { modelId?: string }) => {
    if (serverManager.status !== ServerStatus.RUNNING) {
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
        if (!selected) return
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
      provider.refresh()
    } catch (err: unknown) {
      Logger.error('Failed to unload model', err)
      vscode.window.showErrorMessage(`Failed to unload model: ${err}`)
    }
  })

  const d10 = rc('lemon.selectModel', async () => {
    if (serverManager.status !== ServerStatus.RUNNING) {
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

  const d11 = rc('lemon.refreshServer', () => provider.refresh())

  const d12 = rc('lemon.switchToStandalone', async () => {
    const standalonePort = serverManager.standalonePort
    const standaloneUrl = `http://localhost:${standalonePort}`

    Logger.info('Stopping embedded server to switch to standalone...')
    await serverManager.stop()

    serverManager.setSelectedServer(standaloneUrl, 'Standalone Lemonade')
    vscode.window.showInformationMessage(`Switched to Standalone Lemonade at ${standaloneUrl}`)

    provider.refresh()
  })

  context.subscriptions.push(d1, d2, d3, d4, d5, d6, d7, d8, d9, d10, d11, d12)

  // Check for updates in the background
  binaryManager.checkForUpdates().catch((err: unknown) => {
    Logger.error('Update check failed', err)
  })
}

// Register tree view for Lemonade status
async function createTreeView(serverManager: ServerManager, binaryManager: BinaryManager) {
  const provider = new ServerViewProvider(serverManager, binaryManager)
  vscode.window.createTreeView('lemon.serversView', {
    treeDataProvider: provider,
    showCollapseAll: true
  })
  await provider.refresh()
  return provider
}

// This method is called when your extension is deactivated
export function deactivate() {
  Logger.info('Lemonade extension deactivated')
}
