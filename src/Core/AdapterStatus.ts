export interface AdapterLastError {
  at: string;
  reason: 'timeout' | 'crash' | 'unavailable' | 'cancelled' | 'error';
  message: string;
  recoverable: boolean;
}

export interface AdapterHealth {
  available: boolean;
  version?: string;
  /** Local capability or confirmed upstream handshake — never "command exists" alone. */
  source: 'installed' | 'fallback' | 'remote' | 'unavailable';
  details?: string;
  lastError?: AdapterLastError;
}

export interface AdapterHealthQuery {
  checkHealth(): Promise<AdapterHealth>;
}
