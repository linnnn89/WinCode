/**
 * Adapter contract for optional upstreams (Roslyn, Repomix).
 * FlaUI provides bounded read-only inspection. Upstream implementations remain separate.
 * initialize/dispose are owned by ToolRouter + ResourceManager, not by composite tools.
 */

import { AdapterHealth } from '../Core/AdapterStatus.js';
export type { AdapterHealth, AdapterLastError } from '../Core/AdapterStatus.js';

export interface IAdapter {
  readonly name: string;
  readonly description: string;

  /**
   * Initializes the adapter and checks availability of underlying tools/services.
   */
  initialize(): Promise<void>;

  /**
   * Checks the health and availability status of this adapter.
   */
  checkHealth(): Promise<AdapterHealth>;

  /**
   * Disposes any active processes or connections when shutting down.
   */
  dispose(): Promise<void>;
}
