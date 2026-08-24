import type { LemonadeModel } from './interfaces'

/**
 * Build the subtext shown alongside a model in the tree view.
 *
 * Uses the model's `labels` verbatim (no hardcoded category knowledge), joined
 * by ", ". Falls back to `owned_by`, then `type`. Returns undefined when none
 * of those are present so callers can omit the subtext entirely.
 */
export function getModelLabel(model: Pick<LemonadeModel, 'labels' | 'type' | 'owned_by'>): string | undefined {
  const labels = model.labels
  if (labels && labels.length > 0) return labels.join(', ')
  if (model.owned_by) return model.owned_by
  return model.type
}
