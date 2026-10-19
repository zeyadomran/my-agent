export function codexObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('provider-failed');
  return value as Record<string, unknown>;
}

export function codexId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(value))
    throw new Error('provider-failed');
  return value;
}

export class CodexTurn {
  turnId: string | undefined;
  private finished = false;
  private textBytes = 0;
  private readonly items = new Map<string, { type: string; text: string; complete: boolean }>();
  constructor(
    readonly threadId: string,
    private readonly delta?: (text: string) => void,
    private readonly complete?: (status: string) => void,
  ) {}

  bind(value: unknown) {
    const id = codexId(codexObject(value).id);
    if (this.turnId !== undefined && this.turnId !== id) throw new Error('provider-failed');
    this.turnId = id;
  }

  accept(method: string, params: unknown) {
    if (
      ![
        'turn/started',
        'turn/completed',
        'item/started',
        'item/completed',
        'item/agentMessage/delta',
        'error',
        'thread/compacted',
      ].includes(method)
    )
      return;
    const data = codexObject(params);
    if (data.threadId !== this.threadId || this.finished) throw new Error('provider-failed');
    if (method === 'turn/started') {
      this.bind(data.turn);
      return;
    }
    if (method === 'thread/compacted') return;
    if (method === 'turn/completed') {
      const turn = codexObject(data.turn);
      this.bind(turn);
      if (
        !Array.isArray(turn.items) ||
        !['completed', 'failed', 'interrupted'].includes(String(turn.status))
      )
        throw new Error('provider-failed');
      for (const item of turn.items) this.item(codexObject(item), true);
      this.finished = true;
      this.complete?.(String(turn.status));
      return;
    }
    if (this.turnId === undefined || data.turnId !== this.turnId)
      throw new Error('provider-failed');
    if (method === 'error') {
      if (data.willRetry !== true) throw new Error('provider-failed');
    } else if (method === 'item/agentMessage/delta') {
      const item = this.items.get(codexId(data.itemId));
      if (item?.type !== 'agentMessage' || item.complete || typeof data.delta !== 'string')
        throw new Error('provider-failed');
      this.count(data.delta);
      item.text += data.delta;
      this.delta?.(data.delta);
    } else this.item(codexObject(data.item), method === 'item/completed');
  }

  private item(value: Record<string, unknown>, completed: boolean) {
    const id = codexId(value.id);
    if (
      !['agentMessage', 'userMessage', 'reasoning', 'contextCompaction'].includes(
        String(value.type),
      )
    )
      throw new Error('provider-failed');
    const previous = this.items.get(id);
    if (!completed && previous !== undefined) throw new Error('provider-failed');
    if (previous === undefined && this.items.size >= 256) throw new Error('provider-failed');
    if (previous !== undefined && previous.type !== value.type) throw new Error('provider-failed');
    if (value.type === 'agentMessage') {
      if (typeof value.text !== 'string') throw new Error('provider-failed');
      if (completed) {
        if (!value.text.startsWith(previous?.text ?? '')) throw new Error('provider-failed');
        const suffix = value.text.slice(previous?.text.length ?? 0);
        this.count(suffix);
        if (suffix.length > 0) this.delta?.(suffix);
      }
    }
    this.items.set(id, {
      type: String(value.type),
      text:
        value.type === 'agentMessage' && completed ? String(value.text) : (previous?.text ?? ''),
      complete: completed,
    });
  }

  private count(text: string) {
    this.textBytes += Buffer.byteLength(text);
    if (this.textBytes > 512 * 1024) throw new Error('provider-failed');
  }
}
