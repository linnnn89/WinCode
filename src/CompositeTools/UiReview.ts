import { UiInspectRequest, UiInspectResult } from '../Core/UiContracts.js';
import { mapUiSources, UiSourceEvidence, validateCandidateFiles } from '../Core/UiSourceMapper.js';
import { validateTextQueries } from '../Core/UiTextSearch.js';

export type UiReviewResult = UiInspectResult & {
  sourceEvidence?: UiSourceEvidence;
  sourceEvidenceOmitted?: string;
};

/** Reuse one snapshot so source node IDs and image badges belong to the same observation. */
export async function reviewUi(
  inspect: (request: UiInspectRequest, signal?: AbortSignal) => Promise<UiInspectResult>,
  workspaceRoot: string, request: UiInspectRequest, candidateFiles: string[], signal?: AbortSignal, textQueries?: string[]
): Promise<UiReviewResult> {
  validateCandidateFiles(candidateFiles);
  validateTextQueries(textQueries);
  const snapshot = await inspect(request, signal);
  if (!snapshot.success || !snapshot.tree) return snapshot;
  try {
    const sourceEvidence = await mapUiSources(workspaceRoot, candidateFiles, snapshot.tree, signal, textQueries);
    return { ...snapshot, sourceEvidence };
  } catch (error) {
    if (signal?.aborted) throw error;
    // Source lookup failure must not discard already acquired runtime evidence.
    return { ...snapshot, sourceEvidenceOmitted: 'Source lookup unavailable.' };
  }
}
