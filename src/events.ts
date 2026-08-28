import * as vscode from 'vscode'

/**
 * Shared event object used to ask registered views to refresh.
 *
 * Any part of the extension can call `refreshTreeEvent.fire()` to trigger a
 * tree-view refresh without needing a direct handle to the provider. The tree
 * view provider subscribes to `onDidRequestRefresh` and re-queries its data.
 */
class RefreshEvents {
  private _onDidRequestRefresh = new vscode.EventEmitter<void>()
  readonly onDidRequestRefresh = this._onDidRequestRefresh.event

  /** Fire a refresh request. External callers use this to refresh the tree view. */
  fire(): void {
    this._onDidRequestRefresh.fire()
  }
}

// Module-level singleton event object for requesting tree view refreshes.
export const refreshEvents = new RefreshEvents()
