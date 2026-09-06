/**
 * Base adapter interface for all external capabilities (Repomix, Serena, FlaUI, Snoop, etc.)
 * WinCode MCP Gateway treats upstream tools as external capabilities without modifying their source code.
 */

export interface AdapterHealth {
  available: boolean;
  version?: string;
  source: 'installed' | 'fallback' | 'remote' | 'unavailable';
  details?: string;
}

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
