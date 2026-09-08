export interface UpstreamConnectionStatus {
  commandFound: boolean;
  handshakeOk: boolean;
  /** null = not probed yet; false = last query reported no active project */
  projectActive: boolean | null;
  semanticQueryUsable: boolean;
  mode: 'connected' | 'degraded';
}

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
  /** Layered upstream status. Do not treat available/source as "Serena connected". */
  upstream?: UpstreamConnectionStatus;
  lastError?: AdapterLastError;
}

export interface AdapterHealthQuery {
  checkHealth(): Promise<AdapterHealth>;
}
