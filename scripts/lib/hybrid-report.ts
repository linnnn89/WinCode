/** Fixed-field public summary. Raw responses, model names and error text stay in local transcripts. */
export const acceptanceVersion = 3;
type Sample = { task: string; mode: string; success: boolean; failure?: string; elapsedMs: number;
  modelRequests: number; modelToolRounds: number; mcpCalls: number;
  measuredUsage: { totalTokens: number } | null;
  measuredCacheUsage?: { hitTokens: number; missTokens: number } | null;
  formatCorrection?: { initialFailure: string | null; attempted: boolean; recovered: boolean; modelRequests: number;
    elapsedMs: number; measuredUsage: { totalTokens: number } | null } };
type Integrity = { sourcesUnchanged: boolean; gatewayExited: boolean; fixtureExited: boolean; measurementValid?: boolean };

const failureCategory = (value: string | undefined) => {
  const known = ['INCOMPLETE_MODEL_RESPONSE', 'INVALID_MODEL_RESPONSE', 'FINAL_WITHOUT_OBSERVATION',
    'FINAL_WITHOUT_REQUIRED_EVIDENCE', 'INCORRECT_FINDINGS', 'MODEL_ROUND_BUDGET_EXCEEDED',
    'MODEL_CONTEXT_BUDGET_EXCEEDED', 'MODEL_RESPONSE_BUDGET_EXCEEDED', 'TASK_CANCELLED_OR_TIMED_OUT',
    'INVALID_FINAL_JSON', 'FORMAT_CORRECTION_BUDGET_EXHAUSTED', 'FORMAT_CORRECTION_TOOL_CALL'];
  return value && known.includes(value) ? value : /^MODEL_HTTP_\d{3}$/.test(value ?? '') ? 'MODEL_HTTP_ERROR' : 'OTHER';
};
const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const percentile = (values: number[], fraction: number) => values.sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * fraction) - 1)] ?? null;

export function summarizeModelExperiment(input: { tasks: string[]; repetitions: number; samples: Sample[]; integrity: Integrity }) {
  const { tasks, repetitions, samples } = input;
  if (!tasks.length || new Set(tasks).size !== tasks.length || tasks.some(task => !['T1', 'T2', 'T3', 'T4'].includes(task)) ||
    !Number.isInteger(repetitions) || repetitions < 1 || repetitions > 20 ||
    samples.some(row => !tasks.includes(row.task) || !['native', 'hybrid'].includes(row.mode) || typeof row.success !== 'boolean' ||
      [row.elapsedMs, row.modelRequests, row.modelToolRounds, row.mcpCalls].some(value => !Number.isFinite(value) || value < 0) ||
      (row.measuredUsage && (!Number.isSafeInteger(row.measuredUsage.totalTokens) || row.measuredUsage.totalTokens < 0)) ||
      (row.measuredCacheUsage && [row.measuredCacheUsage.hitTokens, row.measuredCacheUsage.missTokens].some(value => !Number.isSafeInteger(value) || value < 0)) ||
      (row.formatCorrection && (typeof row.formatCorrection.attempted !== 'boolean' || typeof row.formatCorrection.recovered !== 'boolean' ||
        !Number.isSafeInteger(row.formatCorrection.modelRequests) || row.formatCorrection.modelRequests < 0 || row.formatCorrection.modelRequests > 1 ||
        !Number.isFinite(row.formatCorrection.elapsedMs) || row.formatCorrection.elapsedMs < 0 ||
        (row.formatCorrection.measuredUsage && (!Number.isSafeInteger(row.formatCorrection.measuredUsage.totalTokens) || row.formatCorrection.measuredUsage.totalTokens < 0))))))
    throw new Error('Invalid experiment summary input.');
  const integrity = { sourcesUnchanged: input.integrity.sourcesUnchanged === true,
    gatewayExited: input.integrity.gatewayExited === true, fixtureExited: input.integrity.fixtureExited === true,
    measurementValid: input.integrity.measurementValid !== false };
  const eligible = Object.values(integrity).every(Boolean);
  const comparisons = tasks.map(task => {
    const statistics = (mode: string) => {
      const all = samples.filter(row => row.task === task && row.mode === mode), rows = all.filter(row => row.success);
      const missingUsageSamples = all.filter(row => !row.measuredUsage).length;
      const missingCacheSamples = all.filter(row => !row.measuredCacheUsage).length;
      const knownTotalTokens = all.reduce((sum, row) => sum + (row.measuredUsage?.totalTokens ?? 0), 0);
      const knownCacheHitTokens = all.reduce((sum, row) => sum + (row.measuredCacheUsage?.hitTokens ?? 0), 0);
      const knownCacheMissTokens = all.reduce((sum, row) => sum + (row.measuredCacheUsage?.missTokens ?? 0), 0);
      const failureCategories: Record<string, number> = {};
      const corrections = all.filter(row => row.formatCorrection?.attempted).map(row => row.formatCorrection!);
      const knownCorrectionTokens = corrections.reduce((sum, item) => sum + (item.measuredUsage?.totalTokens ?? 0), 0);
      const missingCorrectionUsage = corrections.filter(item => !item.measuredUsage).length;
      for (const row of all.filter(row => !row.success)) { const code = failureCategory(row.failure); failureCategories[code] = (failureCategories[code] ?? 0) + 1; }
      return { samples: all.length, passed: rows.length, failureCategories,
        formatCorrection: { firstPassPassed: rows.filter(row => !row.formatCorrection?.initialFailure).length,
          initialFormatFailures: all.filter(row => row.formatCorrection?.initialFailure === 'INVALID_FINAL_JSON').length,
          attemptedSamples: corrections.length, recoveredSamples: all.filter(row => row.success && row.formatCorrection?.recovered).length,
          modelRequests: corrections.reduce((sum, item) => sum + item.modelRequests, 0),
          elapsedMs: corrections.reduce((sum, item) => sum + item.elapsedMs, 0),
          totalTokens: corrections.length && !missingCorrectionUsage ? knownCorrectionTokens : null,
          knownTotalTokens: knownCorrectionTokens, missingUsageSamples: missingCorrectionUsage },
        p50Ms: percentile(rows.map(row => row.elapsedMs), .5), p95Ms: percentile(rows.map(row => row.elapsedMs), .95),
        meanModelRequests: mean(rows.map(row => row.modelRequests)), meanModelToolRounds: mean(rows.map(row => row.modelToolRounds)),
        meanMcpCalls: mean(rows.map(row => row.mcpCalls)),
        meanTotalTokens: rows.length && rows.every(row => row.measuredUsage) ? mean(rows.map(row => row.measuredUsage!.totalTokens)) : null,
        attempts: { samples: all.length, failed: all.length - rows.length,
          elapsedMs: all.reduce((sum, row) => sum + row.elapsedMs, 0),
          modelRequests: all.reduce((sum, row) => sum + row.modelRequests, 0), mcpCalls: all.reduce((sum, row) => sum + row.mcpCalls, 0),
          totalTokens: all.length && !missingUsageSamples ? knownTotalTokens : null, knownTotalTokens, missingUsageSamples,
          cacheHitTokens: all.length && !missingCacheSamples ? knownCacheHitTokens : null,
          cacheMissTokens: all.length && !missingCacheSamples ? knownCacheMissTokens : null,
          knownCacheHitTokens, knownCacheMissTokens, missingCacheSamples } };
    };
    const native = statistics('native'), hybrid = statistics('hybrid');
    const validComparison = eligible && native.samples === repetitions && hybrid.samples === repetitions &&
      native.passed === repetitions && hybrid.passed === repetitions;
    return { task, native, hybrid, validComparison,
      totalTokenReduction: validComparison && native.meanTotalTokens && hybrid.meanTotalTokens !== null ? 1 - hybrid.meanTotalTokens / native.meanTotalTokens : null,
      medianLatencyReduction: validComparison && native.p50Ms && hybrid.p50Ms !== null ? 1 - hybrid.p50Ms / native.p50Ms : null };
  });
  return { formatVersion: 2, acceptanceVersion, repetitions, plannedSamples: repetitions * tasks.length * 2,
    completedSamples: samples.length, integrity, success: eligible && comparisons.every(row => row.validComparison), comparisons };
}
