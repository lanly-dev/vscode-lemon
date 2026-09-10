import * as vscode from 'vscode'

/**
 * Colors available-model rows in the Servers tree.
 *
 * The tree-item API cannot color label text directly, so loaded models get
 * their green label through the FileDecoration API: each model row carries a
 * `lemon-model:` resource URI encoding its loaded state, and this provider
 * tints matching labels green.
 */
export class ModelDecorationProvider implements vscode.FileDecorationProvider {
  /** Build the resource URI for a model row. */
  static uriFor(modelId: string, isLoaded: boolean): vscode.Uri {
    return vscode.Uri.from({
      scheme: 'lemon-model',
      path: `/${modelId}`,
      query: `loaded=${isLoaded ? '1' : '0'}`
    })
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'lemon-model') return undefined
    if (!uri.query.includes('loaded=1')) return undefined
    return {
      color: new vscode.ThemeColor('charts.green'),
      tooltip: 'Loaded'
    }
  }
}
