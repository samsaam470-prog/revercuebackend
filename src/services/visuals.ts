/**
 * Route-facing wrapper for visual asset resolution.
 *
 * Resolution itself lives in `visual-assets.ts`; keeping this module means the
 * existing import from `/api/organize` does not change.
 */
export {
  resolveVisuals,
  validateRequests,
  type VisualAssetType,
  type VisualRequestInput,
  type ResolvedVisual,
  type RejectedVisual,
  type ResolveVisualsResult,
  type ChartSpec,
  type DiagramSpec,
} from './visual-assets';
