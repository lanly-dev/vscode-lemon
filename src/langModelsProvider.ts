import * as vscode from 'vscode'

import { LemonadeClient } from './lemonadeClient'
import { Logger } from './logger'
import { ModelManager } from './modelManager'
import type { ServerManager } from './serverManager'
import { ServerStatus } from './interfaces'

import type { ChatMessage } from './interfaces'

/**
 * Registers Lemonade Server models with the VS Code Language Model API
 * (`vscode.lm.registerLanguageModelChatProvider`) so they show up in the
 * native VS Code model picker under the "Lemon" provider — the same way
 * Ollama exposes its models.
 */
export class LemonLanguageModelProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
  /** Fired when the available model list may have changed. */
  readonly onDidChangeLanguageModelChatInformation: vscode.Event<void>

  private readonly _onDidChange = new vscode.EventEmitter<void>()
  private disposed = false

  constructor(private serverManager: ServerManager) {
    this.onDidChangeLanguageModelChatInformation = this._onDidChange.event

    // Re-query models whenever the server status or selection changes so the
    // picker stays up to date.
    this.serverManager.onStatusChange((status) => {
      if (status === ServerStatus.RUNNING) this._onDidChange.fire()
    })
    this.serverManager.onServerSelectionChange(() => this._onDidChange.fire())
  }

  /** Register the provider with VS Code. Returns the disposable to add to subscriptions. */
  register(): vscode.Disposable {
    const registration = vscode.lm.registerLanguageModelChatProvider('lemonade', this)
    Logger.info('Registered Lemonade language model provider')
    return registration
  }

  /** List available (downloaded, chat-capable) models from the Lemonade Server. */
  provideLanguageModelChatInformation(
    options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.LanguageModelChatInformation[]> {
    void options
    return this.listModelInformation(token)
  }

  private async listModelInformation(
    token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    if (this.disposed || token.isCancellationRequested) return []

    let models
    try {
      // Use the server-bound client so the selected server (standalone,
      // embedded, or custom) is respected.
      const client = this.serverManager.client
      const all = await client.listModels()
      // Only expose downloaded chat models — the picker should behave like
      // Ollama's: what's installed is what's offered.
      models = all.filter((m) => m.downloaded !== false && (m.labels ?? []).some(
        (l) => l.toLowerCase() === 'chat'
      ))
    } catch (err) {
      // Server offline or unreachable — VS Code will retry via our change event.
      Logger.warn(`Could not list Lemonade models for the model picker: ${err}`)
      return []
    }

    return models.map((m) => ({
      id: m.id,
      name: m.id,
      family: m.recipe ?? 'llamacpp',
      tooltip: `Local model served by Lemonade Server (${this.serverManager.selectedServerName})`,
      detail: ModelManager.getModelLabel(m),
      version: String(m.created ?? 1),
      maxInputTokens: 8192,
      maxOutputTokens: 4096,
      capabilities: {
        toolCalling: false,
        imageInput: false
      }
    }))
  }

  /** Stream a chat completion from the Lemonade Server for the given model. */
  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    void options
    const client = this.serverManager.client

    const chatMessages: ChatMessage[] = messages.map((m) => ({
      role: LemonLanguageModelProvider.toRole(m.role),
      content: LemonLanguageModelProvider.extractText(m)
    })).filter((m) => m.content.length > 0)

    const abortController = new AbortController()
    const subscription = token.onCancellationRequested(() => abortController.abort())

    try {
      await client.chatCompletionStream(
        { model: model.id, messages: chatMessages },
        (chunk) => progress.report(new vscode.LanguageModelTextPart(chunk)),
        abortController.signal
      )
      Logger.info(`Language model response complete for ${model.id}`)
    } finally {
      subscription.dispose()
    }
  }

  /**
   * Rough token estimate (~4 chars per token). Lemonade does not expose a
   * tokenization endpoint, so an approximation keeps the prompt budget sane.
   */
  async provideTokenCount(
    model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatRequestMessage,
    token: vscode.CancellationToken
  ): Promise<number> {
    void model
    void token
    const str = typeof text === 'string' ? text : LemonLanguageModelProvider.extractText(text)
    return Math.ceil(str.length / 4)
  }

  /** Map a VS Code language model role to an OpenAI-style chat role. */
  private static toRole(role: vscode.LanguageModelChatMessageRole): ChatMessage['role'] {
    if (role === vscode.LanguageModelChatMessageRole.Assistant) return 'assistant'
    // The Language Model API only exposes User/Assistant; system-style content
    // arrives as User and is forwarded as such.
    return 'user'
  }

  /** Extract plain text from a VS Code language model request message. */
  private static extractText(message: vscode.LanguageModelChatRequestMessage): string {
    return message.content
      .map((part) => (part instanceof vscode.LanguageModelTextPart ? part.value : ''))
      .join('')
  }

  dispose(): void {
    this.disposed = true
    this._onDidChange.dispose()
  }
}
