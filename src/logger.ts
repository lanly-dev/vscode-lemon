import * as vscode from 'vscode'

// Centralized logger that writes to a VS Code output channel
export class Logger {
  private static channel: vscode.OutputChannel

  static init(): void {
    if (Logger.channel) return
    Logger.channel = vscode.window.createOutputChannel('Lemon')
  }

  static info(message: string): void {
    Logger.init()
    const timestamp = new Date().toISOString()
    Logger.channel.appendLine(`[INFO  ${timestamp}] ${message}`)
  }

  static warn(message: string): void {
    Logger.init()
    const timestamp = new Date().toISOString()
    Logger.channel.appendLine(`[WARN  ${timestamp}] ${message}`)
  }

  static error(message: string, error?: unknown): void {
    Logger.init()
    const timestamp = new Date().toISOString()
    if (error instanceof Error) {
      Logger.channel.appendLine(`[ERROR ${timestamp}] ${message}: ${error.message}`)
      if (error.stack) Logger.channel.appendLine(error.stack)
    } else Logger.channel.appendLine(`[ERROR ${timestamp}] ${message}`)
  }

  static show(): void {
    Logger.init()
    Logger.channel.show()
  }
}
