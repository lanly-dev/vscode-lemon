import * as vscode from 'vscode'
import { BinaryManager } from './binaryManager'
import { ChatParticipant } from './chatParticipant'
import { Logger } from './logger'
import { ServerManager } from './serverManager'
import { ServerViewProvider } from './serverTreeview'

export async function activate(context: vscode.ExtensionContext) {
  const rc = vscode.commands.registerCommand

  // Initialize managers
  const binaryManager = new BinaryManager(context)
  const serverManager = new ServerManager(context, binaryManager)
  const chatParticipant = new ChatParticipant(context, serverManager)
  // Apply the user-configured server mode (standalone / embedded / custom)
  serverManager.applyConfiguredServerMode()
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
    if (!await serverManager.ensureRunning()) return

    const modelName = await vscode.window.showInputBox({
      title: 'Pull Model',
      prompt: 'Enter the model name to download',
      placeHolder: 'Model name'
    })

    if (!modelName) return
    const client = serverManager.getClient()
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
    const modelName = await serverManager.loadModel(item?.modelId)
    if (!modelName) return
    chatParticipant.setSelectedModel(modelName)
    provider.refresh()
  })

  const d9 = rc('lemon.unloadModel', async (item?: { modelId?: string }) => {
    const modelName = await serverManager.unloadModel(item?.modelId)
    if (!modelName) return
    provider.refresh()
  })

  const d10 = rc('lemon.selectModel', async () => {
    const selected = await serverManager.selectModel()
    if (!selected) return
    chatParticipant.setSelectedModel(selected)
    vscode.window.showInformationMessage(`Selected model: ${selected}`)
  })

  const d11 = rc('lemon.refreshServer', () => provider.refresh())

  const d14 = rc('lemon.selectServer', async () => {
    await serverManager.selectServer()
    provider.refresh()
  })

  const d13 = rc('lemon.setMaxLoadedModels', async () => {
    const config = vscode.workspace.getConfiguration('lemon')
    const current = config.get<number>('maxLoadedModels', 1)
    const currentText = current === -1 ? 'Unlimited' : String(current)

    const value = await vscode.window.showInputBox({
      title: 'Set Max Loaded Models',
      prompt: `Current: ${currentText}. Enter the maximum number of loaded models (-1 for unlimited).`,
      placeHolder: 'e.g. 1 or -1 for unlimited',
      value: String(current),
      validateInput: (input) => {
        const trimmed = input.trim()
        if (trimmed === '') return 'Please enter a number'
        const n = Number(trimmed)
        if (!Number.isInteger(n) || n < -1) return 'Enter an integer of -1 or greater (-1 = unlimited)'
        return undefined
      }
    })
    if (value === undefined || value.trim() === '') return

    const n = Number(value)
    try {
      await serverManager.setMaxLoadedModels(n)
      vscode.window.showInformationMessage(`Max loaded models set to ${n === -1 ? 'unlimited' : n}`)
      provider.refresh()
    } catch (err: unknown) {
      Logger.error('Failed to set max loaded models', err)
      vscode.window.showErrorMessage(`Failed to set max loaded models: ${err}`)
    }
  })

  context.subscriptions.push(d1, d2, d3, d4, d5, d6, d7, d8, d9, d10, d11, d12, d13, d14)

  // Re-apply the selected server mode when the relevant settings change
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('lemon.serverMode')
        || e.affectsConfiguration('lemon.customServerUrl')
        || e.affectsConfiguration('lemon.serverPort')
        || e.affectsConfiguration('lemon.embeddedPort')
      ) {
        serverManager.applyConfiguredServerMode()
        provider.refresh()
      }
    })
  )

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
