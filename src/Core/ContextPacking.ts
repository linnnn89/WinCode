export interface RepomixPackOptions {
  include?: string[];
  exclude?: string[];
  maxFiles?: number;
  outputFormat?: 'markdown' | 'xml' | 'plain';
  compress?: boolean;
  candidateFiles?: string[];
}

export interface RepomixPackResult {
  content: string;
  fileCount: number;
  totalCharacters: number;
  fromCache: boolean;
  source: 'repomix-cli' | 'builtin-fallback';
  /** Set when the full snapshot was spilled to disk instead of kept in the heap. */
  overflowPath?: string;
  contentOmitted?: boolean;
  /** UTF-16 offsets of file bodies in content; end is exclusive. */
  fileSpans?: { file: string; start: number; end: number }[];
}

export interface ContextPacker {
  packWorkspace(options?: RepomixPackOptions): Promise<RepomixPackResult>;
}
