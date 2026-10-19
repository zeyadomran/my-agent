import { ProviderFault } from './fault';

export const TURN_ABSOLUTE_MS = 30 * 60_000;

/** Only validated, current-turn progress may refresh this finite operation. */
export class TurnDeadline {
  private inactivity: ReturnType<typeof setTimeout> | undefined;
  private readonly absolute: ReturnType<typeof setTimeout>;
  private closed = false;

  constructor(
    private readonly expire: () => void,
    private readonly inactivityMs = 120_000,
    absoluteMs = TURN_ABSOLUTE_MS,
  ) {
    if (
      !Number.isSafeInteger(inactivityMs) ||
      inactivityMs <= 0 ||
      !Number.isSafeInteger(absoluteMs) ||
      absoluteMs < inactivityMs ||
      absoluteMs > TURN_ABSOLUTE_MS
    )
      throw new ProviderFault('unavailable');
    const timeout = () => {
      this.close();
      expire();
    };
    this.absolute = setTimeout(timeout, absoluteMs);
    this.activity();
  }

  activity() {
    if (this.closed) return;
    clearTimeout(this.inactivity);
    this.inactivity = setTimeout(() => {
      this.close();
      this.expire();
    }, this.inactivityMs);
  }

  close() {
    this.closed = true;
    clearTimeout(this.inactivity);
    clearTimeout(this.absolute);
  }
}
