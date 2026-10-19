import type { ScaffoldBridge } from '../shared/contracts';

declare global {
  interface Window {
    myAgent: ScaffoldBridge;
  }
}
