import type { Tool } from '@modelcontextprotocol/server';
import { Ajv, AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { WORKSPACE_TOOLS } from './WorkspaceTools.js';
import { CODE_TOOLS } from './CodeTools.js';
import { UI_TOOLS } from './UiTools.js';
import { toolsContractHash } from './ContractHash.js';
import type { ToolDefinition, ToolExecutionContext } from './ToolDefinition.js';

const definitions: ToolDefinition[] = [...WORKSPACE_TOOLS, ...CODE_TOOLS, ...UI_TOOLS];

function publishedTools(source: ToolDefinition[]): Tool[] {
  return source.flatMap(definition => [definition.tool, ...(definition.aliases || []).filter(alias => alias.listed)
    .map(alias => ({ ...definition.tool, name: alias.name, description: alias.description ?? definition.tool.description }))]);
}

/** Compatibility export for callers inspecting the published contract, never a second dispatch list. */
export const WINCODE_TOOLS: Tool[] = structuredClone(publishedTools(definitions));

type InputSchema = { type?: string; properties?: Record<string, InputSchema>; items?: InputSchema };

function declaredArguments(value: unknown, schema: InputSchema): unknown {
  if (schema.type === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const input = value as Record<string, unknown>;
    return Object.fromEntries(Object.entries(schema.properties || {})
      .filter(([key]) => Object.hasOwn(input, key))
      .map(([key, child]) => [key, declaredArguments(input[key], child)]));
  }
  if (schema.type === 'array' && Array.isArray(value) && schema.items)
    return value.map(item => declaredArguments(item, schema.items!));
  return value;
}

export class ToolRegistry {
  private readonly entries = new Map<string, { definition: ToolDefinition; validate: ReturnType<AjvJsonSchemaValidator['getValidator']> }>();
  private readonly published: Tool[];
  readonly schemaHash: string;

  constructor() {
    const validator = new AjvJsonSchemaValidator(new Ajv({ strict: false, allErrors: false,
      coerceTypes: false, useDefaults: false, removeAdditional: false }));
    const snapshot = definitions.map(definition => ({ ...definition, tool: structuredClone(definition.tool),
      aliases: structuredClone(definition.aliases) }));
    this.published = structuredClone(publishedTools(snapshot));
    this.schemaHash = toolsContractHash(this.published);
    for (const definition of snapshot) {
      // SDK Tool accepts generic JSON values for extension keywords; the validator
      // exposes the narrower JSON Schema type for the same schema object.
      const validate = validator.getValidator(definition.tool.inputSchema as Parameters<AjvJsonSchemaValidator['getValidator']>[0]);
      for (const name of [definition.tool.name, ...(definition.aliases || []).map(alias => alias.name)]) {
        if (this.entries.has(name)) throw new Error(`Duplicate tool registration: ${name}`);
        this.entries.set(name, { definition, validate });
      }
    }
  }

  list(): Tool[] { return structuredClone(this.published); }

  resolve(name: string): ToolDefinition | undefined { return this.entries.get(name)?.definition; }

  prepare(name: string, args: unknown, context: ToolExecutionContext): Record<string, unknown> {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`Unknown tool: ${name}`);
    const checked = entry.validate(args);
    if (!checked.valid) throw new Error(`Invalid arguments for ${name}: ${checked.errorMessage.slice(0, 2048)}`);
    // Extra fields remain accepted on the wire but cannot alter internal/native requests.
    const known = declaredArguments(args, entry.definition.tool.inputSchema as InputSchema) as Record<string, unknown>;
    entry.definition.validate?.(known, context);
    return known;
  }
}
