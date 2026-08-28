import * as vscode from 'vscode'

import { BinaryManager } from './binaryManager'
import { ChatParticipant } from './chatParticipant'
import { Logger } from './logger'
import { refreshEvents } from './events'
import { ModelManager } from './modelManager'
import { ServerManager } from './serverManager'
import { ServerViewProvider } from './serverTreeview'

export async function activate(context: vscode.ExtensionContext) {
  const rc = vscode.commands.registerCommand

  // Initialize managers
  const binaryManager = new BinaryManager(context)
  const serverManager = new ServerManager(binaryManager)
  const provider = await createTreeView(serverManager)
  const modelManager = new ModelManager(serverManager, provider)
  const chatParticipant = new ChatParticipant(context, serverManager)

  const d1 = rc('lemon.startServer', serverManager.start)
  const d2 = rc('lemon.stopServer', async () => {
    await serverManager.stop()
    refreshEvents.fire()
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

  const d7 = rc('lemon.pullModel', () => modelManager.pullModel())

  const d8 = rc('lemon.loadModel', async (item: { modelId: string }) => {
    await modelManager.loadModel(item.modelId)
    // Need to look into how to update the selected model in the chat participant after loading a model
    // chatParticipant.setSelectedModel(modelName)
    refreshEvents.fire()
  })

  const d9 = rc('lemon.unloadModel', async (item: { modelId: string }) => {
    await modelManager.unloadModel(item.modelId)
    refreshEvents.fire()
  })

  const d17 = rc('lemon.removeModel', async (item: { modelId: string }) => {
    await modelManager.deleteModel(item.modelId)
    provider.clearPartial(item.modelId)
    refreshEvents.fire()
  })

  const d18 = rc('lemon.retryModel', (item: { modelId: string }) => modelManager.startPull(item.modelId))

  const d10 = rc('lemon.selectModel', async () => {
    const selected = await modelManager.selectModel()
    if (!selected) return
    chatParticipant.setSelectedModel(selected)
    vscode.window.showInformationMessage(`Selected model: ${selected}`)
  })

  const d11 = rc('lemon.refreshServer', () => refreshEvents.fire())

  const d14 = rc('lemon.selectServer', async () => {
    await serverManager.selectServer()
    refreshEvents.fire()
  })

  const d13 = rc('lemon.setMaxLoadedModels', () => modelManager.setMaxLoadedModels())

  const d15 = rc('lemon.openServerUrl', (item?: vscode.TreeItem) => {
    const label = item?.label
    if (!label) return
    const url = typeof label === 'string' ? label : label.label
    if (!url) return
    vscode.env.openExternal(vscode.Uri.parse(url))
  })

  const d16 = rc('lemon.editServerPort', async () => {
    const config = vscode.workspace.getConfiguration('lemon')
    const mode = config.get<string>('targetServer', 'standalone')

    // Custom mode edits the URL; standalone/embedded edit the port.
    if (mode === 'custom') {
      const current = config.get<string>('customServerUrl', '') || 'http://localhost:13305'
      const url = await vscode.window.showInputBox({
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
      await config.update('customServerUrl', url.trim(), vscode.ConfigurationTarget.Global)
      vscode.window.showInformationMessage(`Custom server URL updated to ${url.trim()}`)
    } else {
      const isEmbedded = mode === 'embedded'
      const key = isEmbedded ? 'embeddedPort' : 'standalonePort'
      const current = config.get<number>(key, isEmbedded ? 8000 : 13305)

      const value = await vscode.window.showInputBox({
        title: isEmbedded ? 'Embedded Server Port' : 'Standalone Server Port',
        prompt: `Current: ${current}. Enter the port for the ` +
          `${isEmbedded ? 'embedded' : 'standalone'} Lemonade Server.`,
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
      await config.update(key, port, vscode.ConfigurationTarget.Global)
      vscode.window.showInformationMessage(
        `${isEmbedded ? 'Embedded' : 'Standalone'} server port updated to ${port}`
      )
    }

    // applyConfiguredServerMode + refresh are handled onDidChangeConfiguration,
    // but refresh explicitly so the new URL/port is reflected immediately.
    refreshEvents.fire()
  })

  context.subscriptions.push(d1, d2, d4, d5, d6, d7, d8, d9, d10, d11, d13, d14, d15, d16, d17, d18)

  // Re-apply the selected server mode when the relevant settings change
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(async (e) => {
      if (
        e.affectsConfiguration('lemon.targetServer')
        || e.affectsConfiguration('lemon.customServerUrl')
        || e.affectsConfiguration('lemon.standalonePort')
        || e.affectsConfiguration('lemon.embeddedPort')
      ) {
        serverManager.applyConfiguredServerMode()

        // When the user switches away from embedded mode, stop the
        // local embedded process — it's no longer the active server.
        const config = vscode.workspace.getConfiguration('lemon')
        const newMode = config.get<string>('targetServer', 'standalone')
        if (newMode !== 'embedded') await serverManager.stop()

        refreshEvents.fire()
      }
    })
  )
  binaryManager.checkForUpdates()
}

// Register tree view for Lemonade status
async function createTreeView(serverManager: ServerManager) {
  const provider = new ServerViewProvider(serverManager)
  vscode.window.createTreeView('LEMON_TREEVIEW', {
    treeDataProvider: provider,
    showCollapseAll: true
  })
  await refreshEvents.fire()
  return provider
}

// This method is called when your extension is deactivated
export function deactivate() {
  Logger.info('Lemonade extension deactivated')
}
