import * as vscode from 'vscode'

/** Format a byte count as a human-readable size (e.g. 1.2 GB). */
export function formatBytes(value: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = value
  let unit = 0
  while (n >= 1024 && unit < units.length - 1) {
    n /= 1024
    unit++
  }
  return `${n.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

export function openSetting(): void {
  vscode.commands.executeCommand('workbench.action.openSettings', '@ext:lanly-dev.lemon')
}
