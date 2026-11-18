/**
 * @fileoverview Public entrypoint for the monowatch telemetry engine and
 * reusable unit-testable telemetry helpers.
 *
 * Exclusively uses Node.js v24+ built-ins (`node:sqlite`, `node:fs`,
 * `node:path`, `node:os`) bundled inside Antigravity's Electron runtime.
 */

export { createTelemetryEngine } from './telemetry/engine.mjs';
export {
  BASE_MODELS,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_MODEL,
  IMAGE_MODELS,
  createPricingRegistry,
} from './telemetry/models.mjs';
export {
  detectCanaryRouting,
  enumToModelCode,
  isOrchestratorEnum,
  isOrchestratorSlug,
  placeholderToEnum,
  resolveApiProviderInfo,
  resolveOrchestratorPhase,
} from './telemetry/routing.mjs';
export {
  cleanCompactedSummary,
  cleanTurnPrompt,
  detectSystemInjection101,
  parseErrorStepSlice,
  parseImageGenStepSlice,
  parseParentRefProto,
  parseParentReferencesRows,
  parseToolFailureSlice,
} from './telemetry/proto.mjs';
