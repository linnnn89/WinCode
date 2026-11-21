/** One session per workspace router. Dynamic connections can initialize several in the same millisecond. */
export interface WorkspaceSession {
  id: string;
  workspaceRoot: string;
  cacheNamespace: string;
  fingerprint: string | null;
  createdAt: number;
  lastActivity: number;
}

export class SessionManager {
  private static sequence = 0;
  private session: WorkspaceSession | null = null;

  get current(): WorkspaceSession | null {
    return this.session;
  }

  open(workspaceRoot: string, cacheNamespace: string): WorkspaceSession {
    const now = Date.now();
    this.session = {
      id: `ws_${++SessionManager.sequence}_${now.toString(36)}`,
      workspaceRoot,
      cacheNamespace,
      fingerprint: null,
      createdAt: now,
      lastActivity: now,
    };
    return this.session;
  }

  touch(): void {
    if (this.session) this.session.lastActivity = Date.now();
  }

  setFingerprint(fingerprint: string): void {
    if (this.session) {
      this.session.fingerprint = fingerprint;
      this.session.lastActivity = Date.now();
    }
  }

  close(): void {
    this.session = null;
  }
}
