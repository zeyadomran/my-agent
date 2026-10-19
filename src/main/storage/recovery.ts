import type { Snapshot } from './snapshot';
import { validateTransition } from './validation';

/** Recovery is itself committed before any state can be read by the application. */
export function recover(snapshot: Snapshot, now: () => string): Snapshot | null {
  if (
    snapshot.state.activeRun === null &&
    !snapshot.state.messages.some(
      (item) => item.status === 'pending' || item.status === 'streaming',
    )
  )
    return null;
  const next = structuredClone(snapshot);
  const timestamp = now();
  for (const message of next.state.messages) {
    if (message.status === 'pending' || message.status === 'streaming') {
      message.status = 'failed';
      message.updatedAt = timestamp > message.updatedAt ? timestamp : message.updatedAt;
    }
  }
  next.state.activeRun = null;
  next.state.revision++;
  // Never reuse native context whose last in-flight operation has an unknown outcome.
  next.sessions = [];
  validateTransition(snapshot, next);
  return next;
}
