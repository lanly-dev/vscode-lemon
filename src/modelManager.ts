import { ConfigurationTarget, ProgressLocation, QuickPickItem } from 'vscode'
import { window, workspace } from 'vscode'

import { Logger } from './logger'
import { ServerManager } from './serverManager'
import { LemonadeModel, ServerStatus } from './interfaces'

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

  constructor(private serverManager: ServerManager) { }

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
      showInformationMessage(`Model '${modelName}' deleted successfully`)
    } catch (err: unknown) {
      Logger.error('Failed to delete model', err)
      showErrorMessage(`Failed to delete model: ${err}`)
    }
  }

  /**
   * Set the maximum number of concurrently loaded models.
   * Persists the value to the lemon.maxLoadedModels config, and if the
   * embedded server is running, pushes it to the running server immediately.
   * Still fuzzy on how this interacts with currently loaded models.
   */
  async setMaxLoadedModels(value: number): Promise<void> {
    const config = workspace.getConfiguration('lemon')
    await config.update('maxLoadedModels', value, ConfigurationTarget.Global)
    Logger.info(`Set lemon.maxLoadedModels to ${value}`)

    if (this.serverManager.status !== ServerStatus.RUNNING) return
    await this.client.updateConfig({ max_loaded_models: value })
    Logger.info('Pushed max_loaded_models to running server')
  }

  /**
   * Select an active model for chat.
   * Prompts the user to pick a model from the available ones.
   * Resolves to the selected model name, or undefined if cancelled/error.
   */
  async selectModel(): Promise<string | undefined> {
    if (!await this.serverManager.ensureRunning()) return undefined
    return this.promptForModel('Select active model for chat')
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

}
