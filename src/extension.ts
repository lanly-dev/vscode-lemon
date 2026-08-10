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
      prompt: 'Enter the model name to download (e.g., Qwen3-0.6B-GGUF)',
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
