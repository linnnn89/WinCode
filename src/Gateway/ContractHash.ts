import type { Tool } from '@modelcontextprotocol/server';
import { createHash } from 'node:crypto';

/** Stable across object key order; array order is part of a schema's contract. */
export function contractHash(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical) :
    item && typeof item === 'object' ? Object.fromEntries(Object.entries(item)
      .sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, child]) => [key, canonical(child)])) : item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function toolsContractHash(tools: Tool[]): string {
  return contractHash([...tools].sort((a, b) => a.name.localeCompare(b.name, 'en')));
}
