import type { UiReader } from './ReadonlyUiWorkflow.js';
import type { UiNode } from '../Core/UiContracts.js';

export interface CheckboxAuditParameters {
  /** Omit to read the region unconditionally. On reads details; Off skips them. */
  summaryAutomationId?: string;
  regionAutomationId: string;
  checkboxAutomationIds: string[];
  maxDepth?: number;
  maxNodes?: number;
}

/** Known preflight rejection only. Messages and fields never contain rejected input values. */
export class RecipeInputError extends Error {
  readonly workStarted = false;
  readonly recoveryAction = 'revise_parameters';
  constructor(readonly code: 'INVALID_RECIPE_PARAMETERS' | 'UNSUPPORTED_RECIPE', readonly field: string, message: string) {
    super(message);
  }
}

function identifier(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\x00-\x1f]/.test(value))
    throw new RecipeInputError('INVALID_RECIPE_PARAMETERS', field, 'Supply a nonempty AutomationId of at most 256 characters without control characters.');
  return value;
}

function budget(value: unknown, fallback: number, maximum: number, name: string): number {
  const checked = value === undefined ? fallback : value;
  if (!Number.isInteger(checked) || (checked as number) < 1 || (checked as number) > maximum)
    throw new RecipeInputError('INVALID_RECIPE_PARAMETERS', name, `${name} must be an integer from 1 to ${maximum}.`);
  return checked as number;
}

/** Compile only installed recipes, never expressions or model-generated code. Validate before connecting. */
export function createReadonlyUiRecipe(recipe: unknown, parameters: unknown) {
  if (recipe !== 'checkbox-audit') throw new RecipeInputError('UNSUPPORTED_RECIPE', 'recipe', 'Unsupported readonly recipe; use checkbox-audit.');
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters) ||
    Object.keys(parameters).some(key => !['summaryAutomationId', 'regionAutomationId', 'checkboxAutomationIds', 'maxDepth', 'maxNodes'].includes(key)))
    throw new RecipeInputError('INVALID_RECIPE_PARAMETERS', 'parameters',
      'Supply an object with only summaryAutomationId, regionAutomationId, checkboxAutomationIds, maxDepth and maxNodes.');
  const input = parameters as CheckboxAuditParameters;
  const region = identifier(input.regionAutomationId, 'regionAutomationId');
  const summary = input.summaryAutomationId === undefined ? undefined : identifier(input.summaryAutomationId, 'summaryAutomationId');
  if (!Array.isArray(input.checkboxAutomationIds) || input.checkboxAutomationIds.length < 1 || input.checkboxAutomationIds.length > 64)
    throw new RecipeInputError('INVALID_RECIPE_PARAMETERS', 'checkboxAutomationIds', 'Supply 1–64 explicitly selected checkbox AutomationIds.');
  const ids = input.checkboxAutomationIds.map((value, index) => identifier(value, `checkboxAutomationIds[${index}]`));
  if (new Set(ids).size !== ids.length) throw new RecipeInputError('INVALID_RECIPE_PARAMETERS', 'checkboxAutomationIds', 'Checkbox AutomationIds must be distinct.');
  const maxDepth = budget(input.maxDepth, 4, 50, 'maxDepth');
  const maxNodes = budget(input.maxNodes, 300, 5000, 'maxNodes');

  return async (reader: UiReader) => {
    if (summary !== undefined) {
      const value = await reader.inspect({ query: { automationId: summary }, readStates: true, maxDepth: 2, maxNodes: 8 });
      if (value.tree?.automationId !== summary) throw new Error('Summary observation does not match its AutomationId.');
      const state = value.tree.states?.toggle;
      if (state === 'Off') return { detailsRequired: false };
      if (state !== 'On') throw new Error('Summary toggle state is unknown; details were not read.');
    }
    const value = await reader.inspect({ query: { automationId: region }, readStates: true, maxDepth, maxNodes });
    if (value.tree?.automationId !== region) throw new Error('Region observation does not match its AutomationId.');
    const selected = new Map(ids.map(id => [id, [] as UiNode[]]));
    const visit = (node: UiNode) => {
      if (node.automationId) selected.get(node.automationId)?.push(node);
      node.children.forEach(visit);
    };
    visit(value.tree);
    const rows = ids.map(id => {
      const matches = selected.get(id)!;
      if (matches.length !== 1 || matches[0].controlType !== 'CheckBox' || typeof matches[0].isEnabled !== 'boolean' ||
        !['On', 'Off'].includes(matches[0].states?.toggle ?? ''))
        throw new Error('Each selected checkbox must have one complete, unambiguous On/Off observation.');
      return matches[0];
    });
    // Enabled and checked are independent; a disabled On checkbox still contributes to checkedCount.
    const details = { checkedCount: rows.filter(node => node.states!.toggle === 'On').length,
      unchecked: rows.filter(node => node.states!.toggle === 'Off').map(node => node.automationId!).sort(),
      disabled: rows.filter(node => node.isEnabled === false).map(node => node.automationId!).sort() };
    return summary === undefined ? details : { detailsRequired: true, details };
  };
}
