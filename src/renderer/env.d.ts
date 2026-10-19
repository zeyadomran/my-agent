import type { RendererBridge, ScaffoldBridge } from '../shared/contracts';

declare global {
  interface Window {
    myAgent?: ScaffoldBridge & Partial<RendererBridge>;
  }
}
