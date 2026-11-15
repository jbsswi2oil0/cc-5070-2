import { describe, expect, it } from 'vitest';
import type { Actor, FramingConstraints } from '../src/framing/types';
import { solveFraming } from '../src/framing/solver';
import { buildPortals, evaluate, toViewSpace } from '../src/framing/evaluate';
import { safeNdcFromMargins, sampleActorBody } from '../src/framing/sampling';
import { effectiveCaps } from '../src/framing/caps';
import { cameraFromParams } from '../src/framing/geometry';
import { projectPoint } from '../src/framing/projection';

const baseConstraints = (over: Partial<FramingConstraints> = {}): FramingConstraints => ({
  yawDeg: 0,
  fovMaxDeg: 50,
  fovMinDeg: 4,
  horizontalFovMaxDeg: 90,
  workingFovDeg: 40,
  aspect: 16 / 9,
  distanceMin: 2,
  distanceMax: 40,
  margins: { left: 0, right: 0, top: 0, bottom: 0 },
  minCameraHeight: 0.2,
  ...over,
});

const actor = (id: string, x: number, z: number, opts: Partial<Actor> = {}): Actor => ({
  id,
  name: id,
  position: { x, y: 0, z },
  height: 1.8,
  radius: 0.3,
  importance: 3,
  color: '#fff',
  ...opts,
});

describe('sampling and projection', () => {
  it('samples the capsule envelope, not just its centre', () => {
    const samples = sampleActorBody(actor('a', 0, 0), 9, 16);
    const radius = Math.max(...samples.map((s) => Math.hypot(s.point.x, s.point.z)));
    expect(radius).toBeCloseTo(0.3, 5);
    const top = Math.max(...samples.map((s) => s.point.y));
    expect(top).toBeCloseTo(1.8, 5);
  });

  it('projects a point right of the axis onto positive safe NDC x', () => {
    const c = cameraFromParams({ x: 0, y: 1, z: 0 }, 0, { r: 10, s: 0, h: 0, pitchDeg: 0 }, 40, 16 / 9);
    // Looking toward +Z, screen-right is world -X.
    const p = projectPoint({ x: -0.5, y: 1, z: 0 }, c.position, c, Math.tan((40 * Math.PI) / 360), 16 / 9);
    expect(p.x).toBeCloseTo(0.5 / (10 * Math.tan((20 * Math.PI) / 180) * (16 / 9)), 9);
    expect(p.behind).toBe(false);
  });
});

describe('solver', () => {
  it('fits two separated actors inside the safe area on a wide frame', () => {
    const result = solveFraming([actor('a', -2, 0), actor('b', 2, 0)], baseConstraints());
    expect(result.status).toBe('fitted');
    expect(result.evaluation.fits).toBe(true);
    const nines = result.evaluation.actors.map((a) => a.report.insideSafe);
    expect(nines.every(Boolean)).toBe(true);
    // Fov is at or under the cap, never expanded beyond it.
    expect(result.camera.fovDeg).toBeLessThanOrEqual(result.fovCapDeg + 1e-6);
  });

  it('projects every envelope sample of every actor inside the safe rectangle', () => {
    const constraints = baseConstraints({ margins: { left: 0.05, right: 0.05, top: 0.05, bottom: 0.05 } });
    const actors = [actor('a', -3.5, -2, { height: 2.1, importance: 2 }), actor('b', 4, 1, { height: 1.5 }), actor('c', 0, 6, { height: 2.4, importance: 4 })];
    const result = solveFraming(actors, constraints);
    expect(result.status).toBe('fitted');
    const safe = safeNdcFromMargins(constraints.margins);
    for (const ev of result.evaluation.actors) {
      expect(ev.report.bboxNdc.left).toBeGreaterThanOrEqual(safe.left - 1e-6);
      expect(ev.report.bboxNdc.right).toBeLessThanOrEqual(safe.right + 1e-6);
      expect(ev.report.bboxNdc.top).toBeLessThanOrEqual(safe.top + 1e-6);
      expect(ev.report.bboxNdc.bottom).toBeGreaterThanOrEqual(safe.bottom - 1e-6);
    }
  });

  it('reports a tradeoff instead of exceeding the fov cap when actors are far apart', () => {
    const constraints = baseConstraints({ fovMaxDeg: 30, distanceMax: 12, horizontalFovMaxDeg: 45 });
    const actors = [actor('a', -25, -10, { importance: 5 }), actor('b', 25, 10)];
    const result = solveFraming(actors, constraints);
    expect(result.status).toBe('tradeoff');
    expect(result.camera.fovDeg).toBeLessThanOrEqual(result.fovCapDeg + 1e-6);
    expect(result.tradeoff?.summary.length).toBeGreaterThan(20);
    expect(result.evaluation.fits).toBe(false);
  });


  it('keeps the highest-importance actor framed first when the group cannot fit', () => {
    // Three actors spread wider than the lens allows: the solver must sacrifice
    // by importance, not by whichever happens to sit nearest the anchor.
    const constraints = baseConstraints({
      fovMaxDeg: 30,
      horizontalFovMaxDeg: 42,
      distanceMax: 14,
      aspect: 16 / 9,
    });
    const actors = [
      actor('west', -13, -3.5, { importance: 5 }),
      actor('east', 13.5, 3, { importance: 3 }),
      actor('north', 0.5, 9.5, { importance: 2 }),
    ];
    const result = solveFraming(actors, constraints);
    expect(result.status).toBe('tradeoff');
    const west = result.evaluation.actors.find((a) => a.report.id === 'west')!;
    expect(west.report.insideSafe).toBe(true);
    expect(result.camera.fovDeg).toBeLessThanOrEqual(result.fovCapDeg + 1e-6);
  });

  it('is continuous for a small actor move', () => {
    const c = baseConstraints({ margins: { left: 0.08, right: 0.08, top: 0.08, bottom: 0.08 } });
    const a = solveFraming([actor('a', 0, 0), actor('b', 1, 2)], c);
    const b = solveFraming([actor('a', 0.15, 0.05), actor('b', 1, 2)], c);
    const jump = Math.hypot(
      a.camera.position.x - b.camera.position.x,
      a.camera.position.y - b.camera.position.y,
      a.camera.position.z - b.camera.position.z,
    );
    expect(jump).toBeLessThan(1.2);
    if (b.fitted) expect(Math.abs(a.camera.fovDeg - b.camera.fovDeg)).toBeLessThan(8);
  });
});
