import type { UiNode } from '../Core/UiContracts.js';
import type { UiReviewResult } from '../CompositeTools/UiReview.js';
import type { UiCodeCandidate } from '../Core/UiCodeMapper.js';

/** Keep IDs and hierarchy intact so the image remains tied to the same observation. */
export function compactUi(result: Omit<UiReviewResult, 'annotatedPngBase64' | 'screenshotPngBase64'>) {
  const nodes: UiNode[] = [];
  const compactNode = (node: UiNode): UiNode => {
    nodes.push(node);
    const { bounds: _bounds, relativeBounds: _relativeBounds, className: _className, ...kept } = node;
    return { ...kept, children: node.children.map(compactNode) };
  };
  const tree = result.tree ? compactNode(result.tree) : undefined;
  const unnamed = nodes.filter(node => node.controlType === 'Button' && !node.name?.trim());
  const disabled = nodes.filter(node => node.isEnabled === false);
  const validSelector = (value: string | undefined) => Boolean(value?.trim() && value.length <= 256 && !/[\x00-\x1f]/.test(value));
  const expansionRequests: Array<{ tool: string; arguments: Record<string, unknown> }> = [];
  if (result.pid && result.hwnd && tree) {
    const selected = [...new Map([tree, ...unnamed, ...disabled].map(node => [node.id, node])).values()].slice(0, 4);
    for (const node of selected) {
      const query = validSelector(node.automationId) ? { automationId: node.automationId } :
        validSelector(node.name) ? { name: node.name } : undefined;
      if (!query && node !== tree) continue;
      expansionRequests.push({ tool: 'wincode_ui_inspect', arguments: {
        pid: result.pid, hwnd: result.hwnd, backgroundOnly: true, capture: 'none', responseFormat: 'full',
        ...(query ? { query } : {}),
      } });
    }
  }
  const code = result.codeEvidence;
  const candidates: Array<UiCodeCandidate & { id: number }> = [];
  const ids = new Map<string, number>();
  const clues = code?.clues.map(({ candidates: repeated, ...clue }) => ({ ...clue,
    candidateIds: repeated.map(candidate => {
      const key = JSON.stringify(candidate);
      let id = ids.get(key);
      if (id === undefined) { id = candidates.length + 1; ids.set(key, id); candidates.push({ id, ...candidate }); }
      return id;
    }),
  }));
  return {
    summary: { observedNodes: nodes.length, unnamedButtons: unnamed.length, disabledControls: disabled.length,
      treeComplete: result.treeComplete ?? null, truncateReason: result.truncateReason ?? null,
      omittedNodeFields: ['bounds', 'relativeBounds', 'className'],
      nextAction: !result.success ? 'inspect_error' : result.treeComplete === false ? 'expand_relevant_controls' : 'inspect_evidence',
      scope: 'returned-snapshot-only' },
    ...result, tree, responseFormat: 'compact',
    ...(result.queryResult ? { queryResult: { ...result.queryResult, matches: result.queryResult.matches.map(node => ({
      id: node.id, parentId: node.parentId, automationId: node.automationId, name: node.name, controlType: node.controlType,
      isEnabled: node.isEnabled, isOffscreen: node.isOffscreen, states: node.states, propertyIssues: node.propertyIssues,
    })) } } : {}),
    ...(code ? { codeEvidence: { ...code, clues, candidates } } : {}),
    expansionRequests,
    expansionNotice: 'Expansion queries observe live UI again; IDs may change and selectors may be ambiguous. Counts are observations, not defect or binding-causality judgments.',
  };
}
