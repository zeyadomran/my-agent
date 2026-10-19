import type { ProviderEvent } from '../../shared/contracts';
import { ProviderFault } from './fault';

/** Bounded consumer backlog. A stalled subscriber must not retain unlimited streamed output. */
export class EventChannel {
  private readonly queue: { event: ProviderEvent; consumed?: () => void }[] = [];
  private wake: (() => void) | undefined;
  private finished = false;
  private bytes = 0;

  push(event: ProviderEvent) {
    let bytes = event.type === 'delta' ? Buffer.byteLength(event.text) : 0;
    const tail = this.queue.at(-1);
    if (event.type === 'delta' && tail?.event.type === 'delta') {
      // Joining a split UTF-16 surrogate pair changes its UTF-8 byte count.
      const end = tail.event.text.slice(-1);
      const start = event.text.slice(0, 1);
      bytes += Buffer.byteLength(end + start) - Buffer.byteLength(end) - Buffer.byteLength(start);
    }
    if (this.bytes + bytes > 512 * 1024) throw new ProviderFault();
    if (event.type === 'delta' && tail?.event.type === 'delta') {
      tail.event = { type: 'delta', text: tail.event.text + event.text };
    } else {
      if (this.queue.length >= 256) throw new ProviderFault();
      this.queue.push({ event });
    }
    this.bytes += bytes;
    this.wake?.();
  }

  /** Resume only when the consumer requests its next event, after persisting this one. */
  async checkpoint(event: Extract<ProviderEvent, { type: 'session' }>, signal: AbortSignal) {
    if (signal.aborted) throw new ProviderFault();
    let abort = () => {
      /* Assigned synchronously by the promise executor. */
    };
    try {
      await new Promise<void>((resolve, reject) => {
        abort = () => {
          reject(new ProviderFault());
        };
        signal.addEventListener('abort', abort, { once: true });
        this.queue.push({ event, consumed: resolve });
        this.wake?.();
      });
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }

  finish() {
    this.finished = true;
    this.wake?.();
  }

  async *events(): AsyncIterable<ProviderEvent> {
    while (!this.finished || this.queue.length > 0) {
      const item = this.queue.shift();
      if (item === undefined) {
        await new Promise<void>((resolve) => {
          this.wake = resolve;
        });
        this.wake = undefined;
      } else {
        if (item.event.type === 'delta') this.bytes -= Buffer.byteLength(item.event.text);
        yield item.event;
        item.consumed?.();
      }
    }
  }
}
