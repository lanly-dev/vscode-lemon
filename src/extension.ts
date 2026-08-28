import * as vscode from 'vscode'
import { BinaryManager } from './binaryManager'
import { ChatParticipant } from './chatParticipant'
import { refreshEvents } from './events'
import type { LemonadeModel } from './interfaces'
import { Logger } from './logger'
import { getModelLabel } from './modelLabel'
import { ServerManager } from './serverManager'
import { ServerViewProvider } from './serverTreeview'

export async function activate(context: vscode.ExtensionContext) {
  const rc = vscode.commands.registerCommand

  // Initialize managers
  const binaryManager = new BinaryManager(context)
  const serverManager = new ServerManager(context, binaryManager)
  const chatParticipant = new ChatParticipant(context, serverManager)
  const provider = await createTreeView(serverManager)

  /**
   * Pull a specific model by id, showing live progress in a cancellable popup
   * and tracking incomplete downloads in the tree view on cancel/failure.
   */
  const startPull = async (modelId: string): Promise<void> => {
    if (!await serverManager.ensureRunning()) return

    const client = serverManager.client

    // Re-pulling a known-incomplete model: drop its stale "incomplete" marker
    // while it's actively downloading; it will be re-marked if it fails again.
    provider.clearPartial(modelId)

    // Show a live "Downloading Models" entry in the tree view for this model.
    provider.beginDownload(modelId)

    const abortController = new AbortController()

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Pulling model: ${modelId}`,
        cancellable: true
      },
      async (progress, token) => {
        // Cancel the underlying HTTP request when the user dismisses the popup.
        token.onCancellationRequested(() => abortController.abort())
        let lastPct = 0

        try {
          await client.pullModelStream(
            modelId,
            (p) => {
              if (p.pct >= 0) lastPct = p.pct
              // Show the % number live in the popup.
              const pctText = p.pct >= 0 ? `${Math.round(p.pct)}%` : ''
              progress.report({ message: [pctText, p.message].filter(Boolean).join(' ') || 'Downloading...' })
              // Tree updates are throttled to every 5% inside updateDownload.
              provider.updateDownload(modelId, p.pct, p.message, p.written, p.total)
            },
            abortController.signal
          )
          provider.clearPartial(modelId)
          provider.endDownload(modelId)
          refreshEvents.fire()
          vscode.window.showInformationMessage(`Model '${modelId}' pulled successfully`)
        } catch (err: unknown) {
          // Remove from the live list, then keep it as an incomplete download.
          provider.endDownload(modelId)
          if (token.isCancellationRequested) {
            Logger.warn(`Model download cancelled: ${modelId}`)
            provider.markPartial(modelId, lastPct)
            refreshEvents.fire()
            vscode.window.showInformationMessage(
              `Cancelled pulling '${modelId}'. The partial download is now listed under "Incomplete Downloads".`
            )
          } else {
            Logger.error('Failed to pull model', err)
            provider.markPartial(modelId, lastPct)
            refreshEvents.fire()
            vscode.window.showErrorMessage(`Failed to pull model: ${err}`)
          }
        }
      }
    )
  }

  const d1 = rc('lemon.startServer', async () => {
    // start() fires refreshEvents itself whenever it updates the server state.
    await serverManager.start()
  })

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

  const d7 = rc('lemon.pullModel', async () => {
    if (!await serverManager.ensureRunning()) return

    // Fetch the full model catalog (?show_all=true), the same source the
    // desktop Model Manager uses. Each entry is tagged with a `downloaded`
    // flag, so we can present the models that aren't downloaded yet.
    let allModels: LemonadeModel[]
    try {
      allModels = await serverManager.client.listModels(true)
    } catch (err: unknown) {
      Logger.error('Failed to list available models', err)
      vscode.window.showErrorMessage(`Failed to list available models: ${err}`)
      return
    }

    const pullable = allModels.filter((m) => !m.downloaded)
    if (pullable.length === 0) {
      vscode.window.showInformationMessage('All catalog models are already downloaded.')
      return
    }

    // The /v1/models?show_all=true response reports `size` in **GB** (e.g.
    // 0.38, 3.61, 5.2) — omitted when unknown. Format accordingly.
    const formatSize = (sizeGb?: number): string => {
      if (!sizeGb || sizeGb <= 0) return ''
      return sizeGb >= 1024 ? `${(sizeGb / 1024).toFixed(1)} TB` : `${sizeGb.toFixed(2)} GB`
    }

    const items: vscode.QuickPickItem[] = pullable.map((m) => ({
      label: m.id,
      description: getModelLabel(m) ?? '',
      detail: formatSize(m.size) || 'Size not reported'
    }))

    const selected = await vscode.window.showQuickPick(items, {
      title: 'Pull Model',
      placeHolder: 'Choose a model to download'
    })

    if (!selected) return
    await startPull(selected.label)
  })

  const d8 = rc('lemon.loadModel', async (item?: { modelId?: string }) => {
    await serverManager.loadModel(item?.modelId)
    // Need to look into how to update the selected model in the chat participant after loading a model
    // chatParticipant.setSelectedModel(modelName)
    refreshEvents.fire()
  })

  const d9 = rc('lemon.unloadModel', async (item?: { modelId?: string }) => {
    await serverManager.unloadModel(item?.modelId)
    refreshEvents.fire()
  })

  const d17 = rc('lemon.removeModel', async (item?: { modelId?: string }) => {
    await serverManager.deleteModel(item?.modelId)
    if (item?.modelId) provider.clearPartial(item.modelId)
    refreshEvents.fire()
  })

  const d18 = rc('lemon.retryModel', async (item?: { modelId?: string }) => {
    if (!item?.modelId) return
    await startPull(item.modelId)
  })

  const d10 = rc('lemon.selectModel', async () => {
    const selected = await serverManager.selectModel()
    if (!selected) return
    chatParticipant.setSelectedModel(selected)
    vscode.window.showInformationMessage(`Selected model: ${selected}`)
  })

  const d11 = rc('lemon.refreshServer', () => refreshEvents.fire())

  const d14 = rc('lemon.selectServer', async () => {
    await serverManager.selectServer()
    refreshEvents.fire()
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
      refreshEvents.fire()
    } catch (err: unknown) {
      Logger.error('Failed to set max loaded models', err)
      vscode.window.showErrorMessage(`Failed to set max loaded models: ${err}`)
    }
  })

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
