import type { ProviderEvent } from '../../shared/contracts';
import { ProviderFault } from './fault';

/** Bounded consumer backlog. A stalled subscriber must not retain unlimited streamed output. */
export class EventChannel {
  private readonly queue: { event: ProviderEvent; consumed?: () => void }[] = [];
  private wake: (() => void) | undefined;
  private finished = false;
  private bytes = 0;

  push(event: ProviderEvent) {
    const bytes = event.type === 'delta' ? Buffer.byteLength(event.text) : 0;
    if (this.queue.length >= 256 || this.bytes + bytes > 512 * 1024) throw new ProviderFault();
    this.bytes += bytes;
    this.queue.push({ event });
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
