import { describe, expect, it } from 'vitest';
import {
  checkActorsPresent,
  checkBodySizeSpread,
  checkFovLimits,
  checkSafeScreenRange,
  checkTargetBoundsCorrespond,
  shouldAdoptArtifact,
  type ScreenRange,
} from '../tools/release/lib/policy';

const screenRange: ScreenRange = {
  safeLeft: [0.02, 0.2],
  safeRightEdge: [0.8, 0.98],
  safeTop: [0.02, 0.2],
  safeBottomEdge: [0.8, 0.98],
  targetInsideSafeTolerancePx: 2,
};

describe('release acceptance policy', () => {
  it('fails when a required actor is missing', () => {
    // A shared frame that silently dropped a character must not pass acceptance.
    const present = checkActorsPresent(['a', 'b', 'c'], [{ id: 'a' }, { id: 'b' }]);
    expect(present.ok).toBe(false);
    expect(present.detail).toMatch(/c/);
    // The same cast with every id present passes.
    expect(checkActorsPresent(['a', 'b'], [{ id: 'a' }, { id: 'b' }]).ok).toBe(true);
  });

  it('treats an empty cast as missing data, not a valid frame', () => {
    expect(checkActorsPresent(['a'], []).ok).toBe(false);
  });

  it('requires a real spread in body height and radius', () => {
    const same = checkBodySizeSpread(
      [
        { height: 1.8, radius: 0.3 },
        { height: 1.8, radius: 0.3 },
      ],
      { minHeightSpreadMeters: 0.2, minRadiusSpreadMeters: 0.05 },
    );
    expect(same.ok).toBe(false);
    const varied = checkBodySizeSpread(
      [
        { height: 1.4, radius: 0.22 },
        { height: 2.0, radius: 0.46 },
      ],
      { minHeightSpreadMeters: 0.2, minRadiusSpreadMeters: 0.05 },
    );
    expect(varied.ok).toBe(true);
  });

  it('rejects a lens that exceeds either configured cap or the scenario cap', () => {
    const limits = { verticalMaxDeg: 44, horizontalMaxDeg: 74, verticalMinDeg: 6 };
    const constraints = { fovMaxDeg: 60, horizontalFovMaxDeg: 90 };
    expect(checkFovLimits({ fovDeg: 40, horizontalFovDeg: 60, distance: 10 }, constraints, limits).ok).toBe(true);
    // Past the published vertical cap (a widened lens would land here).
    expect(checkFovLimits({ fovDeg: 46, horizontalFovDeg: 60, distance: 10 }, constraints, limits).ok).toBe(false);
    // Past the published horizontal cap.
    expect(checkFovLimits({ fovDeg: 40, horizontalFovDeg: 80, distance: 10 }, constraints, limits).ok).toBe(false);
    // Below the minimum working lens.
    expect(checkFovLimits({ fovDeg: 4, horizontalFovDeg: 8, distance: 10 }, constraints, limits).ok).toBe(false);
  });

  it('checks the safe rectangle against the configured screen fractions', () => {
    const ok = checkSafeScreenRange({ x: 88, y: 50, w: 926, h: 521 }, 1104, 621, screenRange);
    expect(ok.ok).toBe(true);
    // A safe rectangle pushed to the frame edge is outside the accepted range.
    expect(checkSafeScreenRange({ x: 0, y: 0, w: 1104, h: 621 }, 1104, 621, screenRange).ok).toBe(false);
    // A degenerate canvas cannot be judged.
    expect(checkSafeScreenRange({ x: 0, y: 0, w: 1, h: 1 }, 0, 0, screenRange).ok).toBe(false);
  });

  it('binds drawn target boxes to the controller inside/outside verdict', () => {
    const safe = { x: 100, y: 50, w: 800, h: 500 };
    const good = checkTargetBoundsCorrespond(
      [
        { id: 'a', x: 150, y: 100, w: 100, h: 200, insideSafe: true, maxOverflow: 0 },
        { id: 'b', x: 60, y: 300, w: 80, h: 200, insideSafe: false, maxOverflow: 0.1 },
      ],
      safe,
      2,
    );
    expect(good.ok).toBe(true);
    // Reported inside, but drawn straddling the safe edge → contradiction.
    const lie = checkTargetBoundsCorrespond(
      [{ id: 'a', x: 60, y: 100, w: 100, h: 200, insideSafe: true, maxOverflow: 0 }],
      safe,
      2,
    );
    expect(lie.ok).toBe(false);
  });

  it('only adopts an artifact when every check passed', () => {
    expect(shouldAdoptArtifact([{ ok: true }, { ok: true }])).toBe(true);
    expect(shouldAdoptArtifact([{ ok: true }, { ok: false }])).toBe(false);
    // No checks at all is a failure, never a vacuous pass.
    expect(shouldAdoptArtifact([])).toBe(false);
  });
});
