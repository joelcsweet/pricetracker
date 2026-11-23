/**
 * Alert-mode rules, kept separate from the Worker so they can be tested alone.
 *
 *   target — email when the price reaches the target (original behaviour)
 *   drop   — email when a check lands lower than the last recorded price
 *   both   — either of the above (one email per check, target wins)
 *
 * In 'drop' mode the product has no target; it is stored as 0.
 */

export const ALERT_MODES = ['target', 'drop', 'both'];

export const normaliseMode = m => (ALERT_MODES.includes(m) ? m : 'target');
export const targetOn      = m => m !== 'drop';
export const dropOn        = m => m !== 'target';

// A drop is a complete check landing more than a cent below the last complete price.
export function isPriceDrop(previous, price) {
  return previous != null && Number(price) < Number(previous) - 0.004;
}
