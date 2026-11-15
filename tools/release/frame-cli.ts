#!/usr/bin/env -S npx vite-node
/**
 * Auxiliary CLI for shared framing.
 *
 * The GUI is the primary entry point; this tool exists only to *assist* it:
 * solve a scenario headlessly (e.g. to sanity-check a config change in CI) and
 * print the same numbers the GUI shows. It does not render, and it cannot stand
 * in for the release run — acceptance uses the real GUI via run-release.ts.
 *
 * Usage:
 *   npx vite-node tools/release/frame-cli.ts -- --scenario deployment
 *   npx vite-node tools/release/frame-cli.ts -- --scenario deployment --beat 1 --json
 *   npx vite-node tools/release/frame-cli.ts -- --scenario deployment --actors tall,short,broad,slim
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Actor, FramingConstraints } from '../../src/framing/types';
import { solveFraming } from '../../src/framing/solver';
import { scenarioById, scenarios } from '../../src/app/scenarios';

const HERE = dirname(fileURLToPath(import.meta.url));

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const scenarioId = arg('--scenario') ?? 'deployment';
const beat = arg('--beat') ? Number(arg('--beat')) : 0;
const asJson = process.argv.includes('--json');
const onlyActors = arg('--actors')?.split(',').map((s) => s.trim());

// Optional hold-out: a scenario file produced elsewhere can be solved with the
// same kernel without touching the app.
const external = arg('--file');
const scenario = scenarioById(scenarioId);

function positionsAtBeat(index: number): Record<string, [number, number, number]> {
  const out: Record<string, [number, number, number]> = {};
  for (const a of scenario.actors) out[a.id] = [a.position.x, a.position.y, a.position.z];
  for (let i = 0; i < index; i++) {
    for (const m of scenario.beats[i].moves) out[m.actorId] = m.to;
  }
  // Include the current beat's end state so --beat 2 matches the GUI at the
  // end of the second beat.
  const current = scenario.beats[index];
  if (current) for (const m of current.moves) out[m.actorId] = m.to;
  return out;
}

async function loadExternal(): Promise<{ actors: Actor[]; constraints: FramingConstraints } | null> {
  if (!external) return null;
  const raw = JSON.parse(readFileSync(external, 'utf8'));
  return { actors: raw.actors, constraints: raw.constraints };
}

async function main(): Promise<number> {
  const ext = await loadExternal();
  let actors: Actor[];
  let constraints: FramingConstraints;
  if (ext) {
    actors = ext.actors;
    constraints = ext.constraints;
  } else {
    if (!scenarios.some((s) => s.id === scenarioId)) {
      console.error(`unknown scenario '${scenarioId}' (known: ${scenarios.map((s) => s.id).join(', ')})`);
      return 2;
    }
    const pos = positionsAtBeat(beat);
    actors = scenario.actors.map((a) => ({ ...a, position: { x: pos[a.id][0], y: pos[a.id][1], z: pos[a.id][2] } }));
    constraints = { ...scenario.constraints, aspect: 16 / 9 };
  }
  if (onlyActors) actors = actors.filter((a) => onlyActors.includes(a.id));
  if (actors.length === 0) {
    console.error('no actors selected');
    return 3;
  }

  const r = solveFraming(actors, constraints);
  if (asJson) {
    console.log(
      JSON.stringify(
        {
          scenario: ext ? 'external' : scenarioId,
          beat,
          status: r.status,
          lensMode: r.lensMode,
          fitted: r.fitted,
          camera: r.camera,
          safe: r.safe,
          caps: r.caps,
          tradeoff: r.tradeoff,
          actors: r.evaluation.actors.map((a) => ({
            id: a.report.id,
            name: a.report.name,
            insideSafe: a.report.insideSafe,
            maxOverflow: a.report.maxOverflow,
            bboxNdc: a.report.bboxNdc,
          })),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  console.log(`scenario ${ext ? 'external' : scenarioId} · beat ${beat} · ${r.status}${r.tradeoff ? ' (tradeoff)' : ''}`);
  console.log(
    `camera pos (${r.camera.position.x.toFixed(2)}, ${r.camera.position.y.toFixed(2)}, ${r.camera.position.z.toFixed(2)}) · yaw ${r.camera.yawDeg.toFixed(1)}° pitch ${r.camera.pitchDeg.toFixed(1)}°`,
  );
  console.log(
    `fov ${r.camera.fovDeg.toFixed(2)}°V / ${r.camera.horizontalFovDeg.toFixed(2)}°H · cap ${r.fovCapDeg.toFixed(2)}°V · distance ${r.camera.distance.toFixed(2)} m`,
  );
  for (const a of r.evaluation.actors) {
    const rr = a.report;
    console.log(
      `  ${rr.insideSafe ? 'IN ' : 'OUT'} ${rr.name.padEnd(4)} bbox x[${rr.bboxNdc.left.toFixed(2)},${rr.bboxNdc.right.toFixed(2)}] y[${rr.bboxNdc.bottom.toFixed(2)},${rr.bboxNdc.top.toFixed(2)}] overflow ${(rr.maxOverflow * 100).toFixed(1)}%`,
    );
  }
  if (r.tradeoff) console.log(`tradeoff: ${r.tradeoff.summary}`);
  console.log('NOTE: this CLI only assists. Acceptance runs through the GUI (run-release.ts).');
  return 0;
}

main()
  .then((c) => process.exit(c))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

export type { Actor, FramingConstraints };
