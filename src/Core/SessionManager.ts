/**
 * One active workspace session per gateway process (v0.5).
 * Not a multi-tenant server: concurrent workspace_open is serialized by ToolRouter.
 * Architecture still treats the session as a replaceable object so a later
 * multi-workspace mode does not have to fight a hidden global.
 */
export interface WorkspaceSession {
  id: string;
  workspaceRoot: string;
  cacheNamespace: string;
  fingerprint: string | null;
  createdAt: number;
  lastActivity: number;
}

export class SessionManager {
  private session: WorkspaceSession | null = null;
  private seq = 0;

  get current(): WorkspaceSession | null {
    return this.session;
  }

  open(workspaceRoot: string, cacheNamespace: string): WorkspaceSession {
    const now = Date.now();
    this.session = {
      id: `ws_${++this.seq}_${now.toString(36)}`,
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
