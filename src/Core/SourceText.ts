export class SourceEncodingError extends Error {}

/** Text search skips the UTF-8 BOM. Exact source excerpts retain it with the original line text. */
export function decodeSourceText(bytes: Uint8Array, preserveBom = false): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: preserveBom }).decode(bytes);
  } catch {
    throw new SourceEncodingError('Source contains invalid UTF-8.');
  }
  if (text.includes('\0')) throw new SourceEncodingError('Source contains a NUL character.');
  return text;
}
