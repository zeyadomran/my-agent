import { readFileSync, watch } from 'node:fs';

/** Explicit external protocol progress gate; no wall-clock waits. */
export function controlTurn(behavior, handle, acknowledge, keepAfterEof = false) {
  if (!behavior.controlledTurn) return false;
  const seen = new Set();
  const watcher = watch('.', (_event, file) => {
    if (!String(file).startsWith('turn-command-') || !String(file).endsWith('.json')) return;
    const command = JSON.parse(readFileSync(file, 'utf8'));
    if (seen.has(command.id)) return;
    seen.add(command.id);
    handle(command.action);
    acknowledge(command.id);
  });
  if (!keepAfterEof) process.stdin.once('end', () => watcher.close());
  return true;
}
