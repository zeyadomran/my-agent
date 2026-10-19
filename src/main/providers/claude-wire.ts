/** Provider diagnostics never escape this parser. */
export class ClaudeWireError extends Error {
  constructor() {
    super('provider-failed');
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new ClaudeWireError();
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== 'string') throw new ClaudeWireError();
  return value;
}

export class ClaudeWire {
  initialized = false;
  outcome: 'success' | 'failed' | 'missing-session' | undefined;
  private messageId: string | undefined;
  private messageText = '';
  private finalText: string | undefined;
  private stopped = false;
  private readonly blocks = new Map<number, string>();

  constructor(
    readonly sessionId: string,
    readonly onDelta: (text: string) => void,
  ) {}

  accept(line: string): void {
    let input: unknown;
    try {
      input = JSON.parse(line);
    } catch {
      throw new ClaudeWireError();
    }
    const packet = record(input);
    if (
      packet.session_id !== this.sessionId ||
      this.outcome !== undefined ||
      packet.parent_tool_use_id != null
    ) {
      throw new ClaudeWireError();
    }
    if (packet.type === 'result') {
      if (
        packet.is_error === true &&
        typeof packet.subtype === 'string' &&
        packet.subtype.startsWith('error_')
      ) {
        const errors = packet.errors;
        this.outcome =
          !this.initialized &&
          Array.isArray(errors) &&
          errors.length === 1 &&
          errors[0] === `No conversation found with session ID: ${this.sessionId}`
            ? 'missing-session'
            : 'failed';
        return;
      }
      if (
        !this.initialized ||
        packet.subtype !== 'success' ||
        packet.is_error !== false ||
        this.finalText === undefined ||
        packet.result !== this.finalText ||
        (this.messageId !== undefined && !this.stopped)
      )
        throw new ClaudeWireError();
      this.outcome = 'success';
      return;
    }
    if (packet.type === 'system') {
      if (packet.subtype === 'init') {
        if (
          this.initialized ||
          !Array.isArray(packet.tools) ||
          packet.tools.length !== 0 ||
          !Array.isArray(packet.mcp_servers) ||
          packet.mcp_servers.length !== 0
        )
          throw new ClaudeWireError();
        this.initialized = true;
      } else if (!this.initialized) throw new ClaudeWireError();
      return;
    }
    if (!this.initialized) throw new ClaudeWireError();
    if (packet.type === 'rate_limit_event') return;
    if (packet.type === 'assistant') {
      const message = record(packet.message);
      if (
        packet.error !== undefined ||
        message.role !== 'assistant' ||
        (this.messageId !== undefined && message.id !== this.messageId) ||
        !Array.isArray(message.content)
      )
        throw new ClaudeWireError();
      let full = '';
      for (const value of message.content) {
        const block = record(value);
        if (block.type === 'text') full += text(block.text);
        else if (block.type !== 'thinking' && block.type !== 'redacted_thinking')
          throw new ClaudeWireError();
      }
      if (!full.startsWith(this.messageText)) throw new ClaudeWireError();
      this.emit(full.slice(this.messageText.length));
      this.finalText = full;
      return;
    }
    if (packet.type !== 'stream_event') throw new ClaudeWireError();
    const event = record(packet.event);
    if (event.type === 'message_start') {
      if (this.messageId !== undefined && !this.stopped) throw new ClaudeWireError();
      const message = record(event.message);
      if (message.role !== 'assistant' || text(message.id).length === 0)
        throw new ClaudeWireError();
      this.messageId = text(message.id);
      this.messageText = '';
      this.finalText = undefined;
      this.stopped = false;
      this.blocks.clear();
      return;
    }
    if (this.messageId === undefined || this.stopped) throw new ClaudeWireError();
    if (event.type === 'message_stop') {
      if (this.blocks.size !== 0) throw new ClaudeWireError();
      this.stopped = true;
      return;
    }
    if (event.type === 'message_delta') {
      const reason = record(event.delta).stop_reason;
      if (reason === 'tool_use') throw new ClaudeWireError();
      return;
    }
    const index = event.index;
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0)
      throw new ClaudeWireError();
    if (event.type === 'content_block_start') {
      const block = record(event.content_block);
      if (
        this.blocks.has(index) ||
        (block.type !== 'text' && block.type !== 'thinking' && block.type !== 'redacted_thinking')
      )
        throw new ClaudeWireError();
      this.blocks.set(index, text(block.type));
      if (block.type === 'text') this.emit(text(block.text));
    } else if (event.type === 'content_block_stop') {
      if (!this.blocks.delete(index)) throw new ClaudeWireError();
    } else if (event.type === 'content_block_delta') {
      const kind = this.blocks.get(index);
      const delta = record(event.delta);
      if (kind === undefined) throw new ClaudeWireError();
      if (delta.type === 'text_delta' && kind === 'text' && this.finalText === undefined)
        this.emit(text(delta.text));
      else if (
        kind !== 'thinking' ||
        (delta.type !== 'thinking_delta' && delta.type !== 'signature_delta')
      )
        throw new ClaudeWireError();
    } else throw new ClaudeWireError();
  }

  private emit(value: string) {
    this.messageText += value;
    if (value.length !== 0) this.onDelta(value);
  }
}
