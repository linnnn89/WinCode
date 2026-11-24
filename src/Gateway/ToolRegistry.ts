import type { Tool } from '@modelcontextprotocol/server';
import { Ajv, AjvJsonSchemaValidator } from '@modelcontextprotocol/server/validators/ajv';
import { WORKSPACE_TOOLS } from './WorkspaceTools.js';
import { CODE_TOOLS } from './CodeTools.js';
import { UI_TOOLS } from './UiTools.js';
import { toolsContractHash } from './ContractHash.js';
import type { ToolDefinition, ToolValidationContext } from './ToolDefinition.js';

const definitions: ToolDefinition[] = [...WORKSPACE_TOOLS, ...CODE_TOOLS, ...UI_TOOLS];

function publishedTools(source: ToolDefinition[]): Tool[] {
  return source.flatMap(definition => [definition.tool, ...(definition.aliases || []).filter(alias => alias.listed)
    .map(alias => ({ ...definition.tool, name: alias.name, description: alias.description ?? definition.tool.description }))]);
}

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

function connectionDefinitions(dynamic: boolean, backgroundUi: boolean, isolatedKeyboard: boolean, shortcutWindowBound = false) {
  const enabled = definitions.filter(definition => definition.tool.name !== 'wincode_ui_shortcut' || (backgroundUi && shortcutWindowBound));
  const snapshot = enabled.map(definition => ({ ...definition, tool: structuredClone(definition.tool),
    aliases: structuredClone(definition.aliases) }));
  if (dynamic) for (const { tool, workspaceControl, desktopOnly, requestLane } of snapshot) {
    if (desktopOnly) continue;
    const schema = tool.inputSchema;
    const selector = { type: 'string', minLength: 1, maxLength: 4096,
      description: 'Absolute directory of the current task or the project named by the user. Send it on each project request, including after workspace_open.' };
    if (workspaceControl) {
      tool.description = 'Open or confirm the project at path for this request. Other calls independently select their project with workspacePath. Returns a bounded project summary.';
      schema.properties = { ...schema.properties, path: selector };
    } else {
      schema.properties = { ...schema.properties, workspacePath: selector };
      if (requestLane !== 'status') schema.required = [...(schema.required ?? []), 'workspacePath'];
    }
  }
  for (const { tool } of snapshot) {
    const schema = tool.inputSchema;
    if (tool.name === 'wincode_ui_type' && (backgroundUi || !isolatedKeyboard)) {
      tool.description = 'Set the value of one uniquely matched control using UI Automation ValuePattern. Supply mode="setValue".' +
        (backgroundUi ? ' Background writes require the PID and HWND bound by the launcher.' : '');
      schema.properties = { ...schema.properties, mode: { type: 'string', enum: ['setValue'] },
        clearBefore: { type: 'boolean', enum: [false] } };
      schema.required = [...(schema.required ?? []), ...(backgroundUi ? ['pid', 'hwnd'] : []), 'mode'];
    } else if (backgroundUi && (tool.name === 'wincode_ui_inspect' || tool.name === 'wincode_ui_review')) {
      tool.description = (tool.description ?? '').replace(' Requires either pid or hwnd.', '') +
        ' This connection requires both PID and HWND and uses background-only capture.';
      schema.properties = { ...schema.properties, backgroundOnly: { type: 'boolean', enum: [true], default: true } };
      schema.required = [...(schema.required ?? []), 'pid', 'hwnd'];
    }
  }
  return snapshot;
}

/** Snapshot of the default connection's published contract. */
export const WINCODE_TOOLS: Tool[] = publishedTools(connectionDefinitions(false, false, false));

export class ToolRegistry {
  private readonly entries = new Map<string, { definition: ToolDefinition; validate: ReturnType<AjvJsonSchemaValidator['getValidator']> }>();
  private readonly published: Tool[];
  readonly schemaHash: string;

  constructor(dynamic = false, backgroundUi = false, isolatedKeyboard = false, shortcutWindowBound = false) {
    const validator = new AjvJsonSchemaValidator(new Ajv({ strict: false, allErrors: false,
      coerceTypes: false, useDefaults: false, removeAdditional: false }));
    const snapshot = connectionDefinitions(dynamic, backgroundUi, isolatedKeyboard, shortcutWindowBound);
    this.published = structuredClone(publishedTools(snapshot).filter(tool => !backgroundUi ||
      (tool.name !== 'wincode_ui_click' && tool.name !== 'wincode_ui_set_expanded')));
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

  prepare(name: string, args: unknown, context: ToolValidationContext): Record<string, unknown> {
    const entry = this.entries.get(name);
    if (!entry) throw new Error(`Unknown tool: ${name}`);
    const checked = entry.validate(args);
    if (!checked.valid) throw new Error(`Invalid arguments for ${name}: ${checked.errorMessage.slice(0, 2048)}`);
    // Extra fields remain accepted on the wire but cannot alter internal/native requests.
    const known = declaredArguments(args, entry.definition.tool.inputSchema as InputSchema) as Record<string, unknown>;
    // The Gateway consumes this selector. Native helpers and tool-specific validators receive only their own fields.
    delete known.workspacePath;
    entry.definition.validate?.(known, context);
    return known;
  }
}
