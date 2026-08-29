import { ConfigurationTarget, ProgressLocation, QuickPickItem } from 'vscode'
import { window, workspace } from 'vscode'

import { Logger } from './logger'
import { ServerManager } from './serverManager'
import { LemonadeModel, ServerStatus } from './interfaces'
import type { ChatParticipant } from './chatParticipant'

import type { ServerViewProvider } from './serverTreeview'

const { showErrorMessage, showInformationMessage, showQuickPick, showWarningMessage } = window

/**
 * Encapsulates model operations (load, unload, delete, select, max-loaded)
 * against the Lemonade Server. Model logic is kept out of {@link ServerManager}
 * so the server lifecycle manager stays focused on process management.
 */
export class ModelManager {

  /**
   * Build the subtext shown alongside a model in the tree view.
   *
   * Uses the model's `labels` verbatim (no hardcoded category knowledge), joined
   * by ", ". Falls back to `owned_by`, then `type`. Returns undefined when none
   * of those are present so callers can omit the subtext entirely.
   */
  static getModelLabel(model: Pick<LemonadeModel, 'labels' | 'type' | 'owned_by'>): string | undefined {
    const labels = model.labels
    if (labels && labels.length > 0) return labels.join(', ')
    if (model.owned_by) return model.owned_by
    return model.type
  }

  constructor(private serverManager: ServerManager, private treeViewProvider: ServerViewProvider) { }

  /** The client bound to the currently selected server. */
  private get client() {
    return this.serverManager.client
  }

  async loadModel(modelName: string): Promise<void> {
    if (!await this.serverManager.ensureRunning()) return

    try {
      await window.withProgress(
        {
          location: ProgressLocation.Notification,
          title: `Loading model: ${modelName}`,
          cancellable: false
        },
        async (progress) => {
          progress.report({ message: 'Loading...' })
          await this.client.loadModel(modelName)
        }
      )
      showInformationMessage(`Model '${modelName}' loaded successfully`)
    } catch (err: unknown) {
      Logger.error('Failed to load model', err)
      showErrorMessage(`Failed to load model: ${err}`)
    }
    this.treeViewProvider.refresh()
  }

  async unloadModel(modelName: string): Promise<void> {
    if (!await this.serverManager.ensureRunning()) return
    const name = modelName

    try {
      await window.withProgress(
        {
          location: ProgressLocation.Notification,
          title: `Unloading model: ${name}`,
          cancellable: false
        },
        async (progress) => {
          progress.report({ message: 'Unloading...' })
          await this.client.unloadModel(name)
        }
      )
      showInformationMessage(`Model '${name}' unloaded successfully`)
    } catch (err: unknown) {
      Logger.error('Failed to unload model', err)
      showErrorMessage(`Failed to unload model: ${err}`)
    }
    this.treeViewProvider.refresh()
  }

  /**
   * Delete a downloaded model from disk on the selected server.
   */
  async deleteModel(modelName: string): Promise<void> {
    if (!await this.serverManager.ensureRunning()) return

    try {
      const confirm = await window.showWarningMessage(
        `Delete model '${modelName}' from disk? This cannot be undone.`,
        { modal: true },
        'Delete'
      )
      if (confirm !== 'Delete') return

      await window.withProgress(
        {
          location: ProgressLocation.Notification,
          title: `Deleting model: ${modelName}`,
          cancellable: false
        },
        async (progress) => {
          progress.report({ message: 'Deleting...' })
          await this.client.deleteModel(modelName)
        }
      )
      this.treeViewProvider.clearPartial(modelName)
      this.treeViewProvider.refresh()
      showInformationMessage(`Model '${modelName}' deleted successfully`)
    } catch (err: unknown) {
      Logger.error('Failed to delete model', err)
      showErrorMessage(`Failed to delete model: ${err}`)
    }
  }

  /**
   * Prompt the user for a new maximum number of concurrently loaded models,
   * persist the value to the lemon.maxLoadedModels config, and if the embedded
   * server is running, push it to the running server immediately.
   */
  async setMaxLoadedModels(): Promise<void> {
    const config = workspace.getConfiguration('lemon')
    const current = config.get<number>('maxLoadedModels', 1)
    const currentText = current === -1 ? 'Unlimited' : String(current)

    const value = await window.showInputBox({
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
      await config.update('maxLoadedModels', n, ConfigurationTarget.Global)
      Logger.info(`Set lemon.maxLoadedModels to ${n}`)

      if (this.serverManager.status === ServerStatus.RUNNING) {
        await this.client.updateConfig({ max_loaded_models: n })
        Logger.info('Pushed max_loaded_models to running server')
      }

      showInformationMessage(`Max loaded models set to ${n === -1 ? 'unlimited' : n}`)
      this.treeViewProvider.refresh()
    } catch (err: unknown) {
      Logger.error('Failed to set max loaded models', err)
      showErrorMessage(`Failed to set max loaded models: ${err}`)
    }
  }

  /**
   * Select an active model for chat.
   * Prompts the user to pick a model from the available ones.
   * Resolves to the selected model name, or undefined if cancelled/error.
   */
  async selectChatModel(chatParticipant: ChatParticipant): Promise<void> {
    if (!await this.serverManager.ensureRunning()) return undefined
    const selected = await this.promptForModel('Select active model for chat')
    if (!selected) return
    // TODO: what is vscode.ChatParticipant about
    chatParticipant.setSelectedModel(selected)
    showInformationMessage(`Selected model for chat: ${selected}`)
  }

  /** Show a quick pick of the available models and return the selected model name. */
  private async promptForModel(title: string): Promise<string | undefined> {
    try {
      const models = await this.client.listModels()
      if (models.length === 0) {
        showWarningMessage('No models available. Pull a model first.')
        return undefined
      }
      const items: QuickPickItem[] = models.map((m) => ({
        label: m.id,
        description: ModelManager.getModelLabel(m) ?? m.owned_by ?? ''
      }))
      const selected = await showQuickPick(items, {
        title,
        placeHolder: 'Choose a model'
      })
      return selected?.label
    } catch (err: unknown) {
      Logger.error('Failed to list models', err)
      showErrorMessage(`Failed to list models: ${err}`)
      return undefined
    }
  }

  /**
   * Show a picker of downloadable catalog models and pull the user's selection.
   * Non-downloaded models from the server catalog are listed with their sizes.
   */
  async pullModel(): Promise<void> {
    if (!await this.serverManager.ensureRunning()) return

    // Fetch the full model catalog (?show_all=true), the same source the
    // desktop Model Manager uses. Each entry is tagged with a `downloaded`
    // flag, so we can present the models that aren't downloaded yet.
    let allModels: LemonadeModel[]
    try {
      allModels = await this.client.listModels(true)
    } catch (err: unknown) {
      Logger.error('Failed to list available models', err)
      showErrorMessage(`Failed to list available models: ${err}`)
      return
    }

    const pullable = allModels.filter((m) => !m.downloaded)
    if (pullable.length === 0) {
      showInformationMessage('All catalog models are already downloaded.')
      return
    }

    // The /v1/models?show_all=true response reports `size` in **GB** (e.g.
    // 0.38, 3.61, 5.2) — omitted when unknown. Format accordingly.
    const formatSize = (sizeGb?: number): string => {
      if (!sizeGb || sizeGb <= 0) return ''
      return sizeGb >= 1024 ? `${(sizeGb / 1024).toFixed(1)} TB` : `${sizeGb.toFixed(2)} GB`
    }

    const items: QuickPickItem[] = pullable.map((m) => ({
      label: m.id,
      description: ModelManager.getModelLabel(m) ?? '',
      detail: formatSize(m.size) || 'Size not reported'
    }))

    const selected = await showQuickPick(items, {
      title: 'Pull Model',
      placeHolder: 'Choose a model to download'
    })

    if (!selected) return
    await this.startPull(selected.label)
  }

  /**
   * Pull a specific model by id, showing live progress in a cancellable popup
   * and tracking incomplete downloads in the tree view on cancel/failure.
   */
  async startPull(modelId: string): Promise<void> {
    if (!await this.serverManager.ensureRunning()) return

    const client = this.serverManager.client

    // Re-pulling a known-incomplete model: drop its stale "incomplete" marker
    // while it's actively downloading; it will be re-marked if it fails again.
    this.treeViewProvider.clearPartial(modelId)

    // Show a live "Downloading Models" entry in the tree view for this model.
    this.treeViewProvider.beginDownload(modelId)

    const abortController = new AbortController()

    await window.withProgress(
      {
        location: ProgressLocation.Notification,
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
              this.treeViewProvider.updateDownload(modelId, p.pct, p.message, p.written, p.total)
            },
            abortController.signal
          )
          this.treeViewProvider.clearPartial(modelId)
          this.treeViewProvider.endDownload(modelId)
          this.treeViewProvider.refresh()
          showInformationMessage(`Model '${modelId}' pulled successfully`)
        } catch (err: unknown) {
          // Remove from the live list, then keep it as an incomplete download.
          this.treeViewProvider.endDownload(modelId)
          if (token.isCancellationRequested) {
            Logger.warn(`Model download cancelled: ${modelId}`)
            this.treeViewProvider.markPartial(modelId, lastPct)
            this.treeViewProvider.refresh()
            showInformationMessage(
              `Cancelled pulling '${modelId}'. The partial download is now listed under "Incomplete Downloads".`
            )
          } else {
            Logger.error('Failed to pull model', err)
            this.treeViewProvider.markPartial(modelId, lastPct)
            this.treeViewProvider.refresh()
            showErrorMessage(`Failed to pull model: ${err}`)
          }
        }
      }
    )
  }

}
