import type { FramingConstraints, Margins } from './types';
import { normalizeMargins } from './sampling';
import { deg, rad } from './vector';

export interface EffectiveCaps {
  /** Largest vertical fov the renderer may use. */
  verticalFovCapDeg: number;
  /** Vertical fov equivalent of the horizontal cap at this aspect. */
  horizontalCapAsVerticalDeg: number;
  /** Which cap binds first. */
  binding: 'vertical' | 'horizontal';
}

export function effectiveCaps(constraints: FramingConstraints): EffectiveCaps {
  const aspect = Math.max(0.05, constraints.aspect);
  const hAsV = deg(2 * Math.atan(Math.tan(rad(constraints.horizontalFovMaxDeg) / 2) / aspect));
  const verticalFovCapDeg = Math.min(constraints.fovMaxDeg, hAsV);
  return {
    verticalFovCapDeg,
    horizontalCapAsVerticalDeg: hAsV,
    binding: hAsV < constraints.fovMaxDeg ? 'horizontal' : 'vertical',
  };
}

export function constraintsWithNormalizedMargins(c: FramingConstraints): FramingConstraints {
  return { ...c, margins: normalizeMargins(c.margins) };
}

export function marginLabels(m: Margins): string {
  return [m.left, m.top, m.right, m.bottom].map((v) => `${Math.round(v * 100)}%`).join(' / ');
}
