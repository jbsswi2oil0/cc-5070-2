import { describe, expect, it } from 'vitest';
import type { Actor, FramingConstraints } from '../src/framing/types';
import { solveFraming } from '../src/framing/solver';

/** Deterministic PRNG so failures are reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomScenario(rand: () => number): { actors: Actor[]; constraints: FramingConstraints } {
  const n = 1 + Math.floor(rand() * 5);
  const actors: Actor[] = [];
  for (let i = 0; i < n; i++) {
    const height = 1.4 + rand() * 1.1;
    actors.push({
      id: `a${i}`,
      name: `A${i}`,
      position: {
        x: (rand() - 0.5) * 24,
        y: rand() < 0.4 ? rand() * 2.6 : 0,
        z: (rand() - 0.5) * 20,
      },
      height,
      radius: 0.22 + rand() * 0.22,
      importance: 1 + Math.floor(rand() * 5),
      color: '#fff',
    });
  }
  const aspect = [9 / 16, 4 / 3, 16 / 9, 21 / 9][Math.floor(rand() * 4)];
  return {
    actors,
    constraints: {
      yawDeg: (rand() - 0.5) * 100,
      fovMaxDeg: 22 + rand() * 50,
      fovMinDeg: 5,
      horizontalFovMaxDeg: 28 + rand() * 90,
      workingFovDeg: 24 + rand() * 30,
      aspect,
      distanceMin: 1.2 + rand() * 2,
      distanceMax: 8 + rand() * 45,
      margins: {
        left: rand() * 0.12,
        right: rand() * 0.12,
        top: rand() * 0.12,
        bottom: rand() * 0.12,
      },
      minCameraHeight: 0.2 + rand() * 0.4,
    },
  };
}

describe('solver invariants under random scenarios', () => {
  it('never exceeds hard caps, returns finite numbers, and matches dense reports', () => {
    const rand = mulberry32(20261115);
    let fittedCount = 0;
    let tradeoffCount = 0;
    for (let t = 0; t < 60; t++) {
      const { actors, constraints } = randomScenario(rand);
      const r = solveFraming(actors, constraints);
      const c = r.camera;
      expect(Number.isFinite(c.position.x)).toBe(true);
      expect(Number.isFinite(c.position.y)).toBe(true);
      expect(Number.isFinite(c.position.z)).toBe(true);
      expect(Number.isFinite(c.fovDeg)).toBe(true);
      expect(c.fovDeg).toBeGreaterThanOrEqual(r.constraints.fovMinDeg - 1e-6);
      // Hard vertical and horizontal caps.
      expect(c.fovDeg).toBeLessThanOrEqual(r.fovCapDeg + 1e-6);
      expect(c.horizontalFovDeg).toBeLessThanOrEqual(r.constraints.horizontalFovMaxDeg + 1e-4);
      // Distance bounds and camera floor.
      expect(c.distance).toBeGreaterThanOrEqual(r.constraints.distanceMin - 1e-6);
      expect(c.distance).toBeLessThanOrEqual(r.constraints.distanceMax + 1e-6);
      expect(c.position.y).toBeGreaterThanOrEqual(r.constraints.minCameraHeight - 1e-3);
      if (r.status === 'fitted') {
        fittedCount++;
        for (const a of r.evaluation.actors) {
          expect(a.report.pointsBehind).toBe(0);
          expect(a.report.insideSafe).toBe(true);
        }
      } else {
        tradeoffCount++;
        expect(r.tradeoff).not.toBeNull();
        expect(r.tradeoff!.summary.length).toBeGreaterThan(10);
      }
    }
    // Both outcomes must be exercised by the corpus.
    expect(fittedCount).toBeGreaterThan(10);
    expect(tradeoffCount).toBeGreaterThan(3);
  });

  it('stays under a real-time budget for five actors', () => {
    const rand = mulberry32(77);
    const actors: Actor[] = Array.from({ length: 5 }, (_, i) => ({
      id: `a${i}`,
      name: `A${i}`,
      position: { x: (rand() - 0.5) * 12, y: rand() * 1.5, z: (rand() - 0.5) * 10 },
      height: 1.5 + rand() * 0.9,
      radius: 0.35,
      importance: 1 + Math.floor(rand() * 5),
      color: '#fff',
    }));
    const constraints: FramingConstraints = {
      yawDeg: 12,
      fovMaxDeg: 55,
      fovMinDeg: 6,
      horizontalFovMaxDeg: 90,
      workingFovDeg: 38,
      aspect: 16 / 9,
      distanceMin: 1.5,
      distanceMax: 40,
      margins: { left: 0.06, right: 0.06, top: 0.06, bottom: 0.06 },
      minCameraHeight: 0.25,
    };
    const t0 = performance.now();
    const r = solveFraming(actors, constraints);
    const ms = performance.now() - t0;
    expect(r.evaluations).toBeGreaterThan(0);
    expect(ms).toBeLessThan(250);
  });
});
