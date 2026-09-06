import { WinCodeConfig } from '../Core/Config.js';

export interface IWinCodeExtension {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  initialize(config: WinCodeConfig): Promise<void>;
  isSupportedOnCurrentPlatform(): boolean;
  dispose(): Promise<void>;
}

/** Reserved plugin slot. v0.4 registers no FlaUI/Snoop/PerfView implementations. */
export class ExtensionManager {
  private extensions: Map<string, IWinCodeExtension> = new Map();
  private config: WinCodeConfig;

  constructor(config: WinCodeConfig) {
    this.config = config;
  }

  registerExtension(extension: IWinCodeExtension): void {
    if (this.extensions.has(extension.id)) {
      console.warn(`[ExtensionManager] Extension ${extension.id} already registered. Overwriting.`);
    }
    this.extensions.set(extension.id, extension);
  }

  async initializeAll(): Promise<void> {
    for (const [id, ext] of this.extensions) {
      if (ext.isSupportedOnCurrentPlatform()) {
        try {
          await ext.initialize(this.config);
        } catch (err) {
          console.warn(`[ExtensionManager] Failed to initialize extension ${id}:`, err);
        }
      }
    }
  }

  getExtension<T extends IWinCodeExtension>(id: string): T | undefined {
    return this.extensions.get(id) as T | undefined;
  }

  listExtensions(): { id: string; name: string; supported: boolean }[] {
    return Array.from(this.extensions.values()).map((ext) => ({
      id: ext.id,
      name: ext.name,
      supported: ext.isSupportedOnCurrentPlatform(),
    }));
  }

  async disposeAll(): Promise<void> {
    for (const ext of this.extensions.values()) {
      try {
        await ext.dispose();
      } catch {
        // Ignore
      }
    }
    this.extensions.clear();
  }
}
