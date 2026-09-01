import * as vscode from 'vscode'

import { BinaryManager } from './binaryManager'
import { ChatParticipant } from './chatParticipant'
import { Logger } from './logger'
import { ModelManager } from './modelManager'
import { ServerManager } from './serverManager'
import { ServerViewProvider } from './serverTreeview'

import { openSetting, openUrl } from './utils'
import { refreshEvents } from './events'

export async function activate(context: vscode.ExtensionContext) {
  const rc = vscode.commands.registerCommand

  // Initialize managers
  const binaryManager = new BinaryManager(context)
  const serverManager = new ServerManager(binaryManager)
  const provider = await createTreeView(context, serverManager)

  const modelManager = new ModelManager(serverManager, provider)
  const chatParticipant = new ChatParticipant(context, serverManager)

  const d1 = rc('lemon.startServer', () => serverManager.start())
  const d2 = rc('lemon.stopServer', () => serverManager.stop())
  const d3 = rc('lemon.downloadBinary', () => binaryManager.downloadBinary())
  const d4 = rc('lemon.openChat', ChatParticipant.openChat)
  const d5 = rc('lemon.openSettings', openSetting)
  const d6 = rc('lemon.pullModel', () => modelManager.pullModel())
  const d7 = rc('lemon.loadModel', (item: { modelId: string }) => modelManager.loadModel(item.modelId))
  const d8 = rc('lemon.unloadModel', (item: { modelId: string }) => modelManager.unloadModel(item.modelId))
  const d9 = rc('lemon.selectChatModel', async () => modelManager.selectChatModel(chatParticipant))
  const d10 = rc('lemon.refreshServer', () => refreshEvents.fire())
  const d11 = rc('lemon.setMaxLoadedModels', () => modelManager.setMaxLoadedModels())
  const d12 = rc('lemon.selectServer', () => serverManager.selectServer())
  const d13 = rc('lemon.openServerUrl', openUrl)
  const d14 = rc('lemon.editServerPort', () => serverManager.editServerPort())

  const d15 = rc('lemon.removeModel', async (item: { modelId: string }) => modelManager.deleteModel(item.modelId))
  const d16 = rc('lemon.retryModel', (item: { modelId: string }) => modelManager.startPull(item.modelId))
  const d17 = listenConfigsChange(serverManager)

  context.subscriptions.push(d1, d2, d3, d4, d5, d6, d7, d8, d9, d10, d11, d12, d13, d14, d15, d16, d17)
  binaryManager.checkForUpdates()
}

function listenConfigsChange(serverManager: ServerManager) {
  return vscode.workspace.onDidChangeConfiguration(async (e) => {
    const settings = ['lemon.targetServer', 'lemon.customServerUrl', 'lemon.standalonePort', 'lemon.embeddedPort']

    if (settings.some((setting) => e.affectsConfiguration(setting))) {
      serverManager.applyConfiguredServerMode()

      // When the user switches away from embedded mode, stop the local embedded process
      // it's no longer the active server.
      const config = vscode.workspace.getConfiguration('lemon')
      const newMode = config.get<string>('targetServer', 'standalone')
      // TODO: Check if stop before switching away from embedded mode
      if (newMode !== 'embedded') await serverManager.stop()

      refreshEvents.fire()
    }
  })
}

// Register tree view for Lemonade status
async function createTreeView(context: vscode.ExtensionContext, serverManager: ServerManager) {
  const provider = new ServerViewProvider(context, serverManager)
  vscode.window.createTreeView('LEMON_TREEVIEW', { treeDataProvider: provider, showCollapseAll: true })
  await refreshEvents.fire()
  return provider
}

// This method is called when your extension is deactivated
export function deactivate() {
  Logger.info('Lemonade extension deactivated')
}
