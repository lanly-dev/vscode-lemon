import * as vscode from 'vscode'

import { BinaryManager } from './binaryManager'
import { ChatParticipant } from './chatParticipant'
import { Logger } from './logger'
import { ModelManager } from './modelManager'
import { ServerManager } from './serverManager'
import { ServerViewProvider } from './serverTreeview'

import { openSetting } from './utils'
import { refreshEvents } from './events'

export async function activate(context: vscode.ExtensionContext) {
  const rc = vscode.commands.registerCommand

  // Initialize managers
  const binaryManager = new BinaryManager(context)
  const serverManager = new ServerManager(binaryManager)
  const provider = await createTreeView(serverManager)
  const modelManager = new ModelManager(serverManager, provider)
  const chatParticipant = new ChatParticipant(context, serverManager)

  const d1 = rc('lemon.startServer', serverManager.start)
  const d2 = rc('lemon.stopServer', serverManager.stop)
  const d4 = rc('lemon.downloadBinary', binaryManager.downloadBinary)
  const d5 = rc('lemon.openChat', ChatParticipant.openChat)
  const d6 = rc('lemon.openSettings', openSetting)
  const d7 = rc('lemon.pullModel', () => modelManager.pullModel())
  const d8 = rc('lemon.loadModel', (item: { modelId: string }) => modelManager.loadModel(item.modelId))
  const d9 = rc('lemon.unloadModel', (item: { modelId: string }) => modelManager.unloadModel(item.modelId))

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

  const d16 = rc('lemon.editServerPort', serverManager.editServerPort)

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
