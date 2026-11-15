import type { Vec3 } from './vector';

export interface Actor {
  id: string;
  name: string;
  /** Feet position. The body extends up to position.y + height. */
  position: Vec3;
  height: number;
  /** Capsule envelope radius around the body's vertical axis. */
  radius: number;
  /** 1 = incidental, 5 = principal; drives priority in a tradeoff. */
  importance: number;
  color: string;
}

export interface Margins {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface FramingConstraints {
  /** Camera azimuth, degrees. 0 looks toward +Z, positive rotates toward +X. */
  yawDeg: number;
  /** Hard upper bound for the vertical fov, degrees. */
  fovMaxDeg: number;
  /** Never render tighter than this, degrees. */
  fovMinDeg: number;
  /** Hard upper bound for the horizontal fov, degrees. */
  horizontalFovMaxDeg: number;
  /** Preferred vertical lens. Widened only when needed, never past the caps. */
  workingFovDeg: number;
  /** Viewport aspect ratio (width / height). */
  aspect: number;
  distanceMin: number;
  distanceMax: number;
  /** Fractions of the frame kept clear on each side, 0..0.45. */
  margins: Margins;
  minCameraHeight: number;
}

export interface SafeNdc {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface SolverParams {
  /** Backoff from the weighted anchor along forward. */
  r: number;
  /** Lateral shift along right. */
  s: number;
  /** Vertical shift along up. */
  h: number;
  /** Look elevation, positive up, degrees. */
  pitchDeg: number;
}

export interface CameraSolution {
  position: Vec3;
  forward: Vec3;
  right: Vec3;
  up: Vec3;
  /** Point the camera is aimed at. */
  target: Vec3;
  yawDeg: number;
  pitchDeg: number;
  fovDeg: number;
  horizontalFovDeg: number;
  /** Distance from position to target. */
  distance: number;
  aspect: number;
  params: SolverParams;
}

export type ClipSide = 'left' | 'right' | 'top' | 'bottom' | 'behind';

export interface ActorFitReport {
  id: string;
  name: string;
  importance: number;
  color: string;
  /** Projected envelope bounds, NDC. */
  bboxNdc: { left: number; right: number; top: number; bottom: number };
  /** Mean projected position of the envelope, NDC. */
  centerNdc: { x: number; y: number; z: number };
  insideSafe: boolean;
  pointsBehind: number;
  clippedSides: ClipSide[];
  /** Signed overflow beyond the safe box, NDC units, per side. */
  overflow: { left: number; right: number; top: number; bottom: number };
  maxOverflow: number;
  /** Fraction of envelope samples inside the safe rectangle. */
  coverage: number;
  sampleCount: number;
  projectedArea: number;
}

export type ReasonCode =
  | 'fov-cap'
  | 'horizontal-cap'
  | 'distance-cap'
  | 'distance-floor'
  | 'camera-floor'
  | 'actor-behind'
  | 'margin';

export interface FramingSuggestion {
  verticalFovDeg: number;
  horizontalFovDeg: number;
  distanceMax: number;
  cheaper: 'fov' | 'distance';
}

export interface TradeoffInfo {
  reasonCodes: ReasonCode[];
  clippedActors: string[];
  worstActorId: string | null;
  summary: string;
  requiredFovDeg: number;
  requiredHorizontalFovDeg: number;
  /** Effective vertical fov ceiling that stopped the solve. */
  capDeg: number;
}
