#!/usr/bin/env -S npx vite-node
/**
 * Shared-framing release runner.
 *
 * Boots the *built* app through `vite preview`, then drives the real GUI with a
 * real browser: it clicks the on-screen reframe button, moves the margin
 * sliders, drags actors inside the canvas, plays the demo, and reads the
 * resulting frame back from the live controller (`window.framingDemo`) and the
 * rendered stage. No pre-rendered footage and no synthetic frame exists in this
 * pipeline — if the controller does not run, the run fails instead of falling
 * back to a canned shot.
 *
 * Usage:
 *   npx vite-node tools/release/run-release.ts -- --out evidence/
 *
 * Exit code is 0 only when every check passes. A non-zero exit means the
 * artifact must not be adopted.
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from 'playwright';
import { probeFrame, dragWithinStage, type ProbedFrame } from './lib/dom';
import {
  checkActorsPresent,
  checkBodySizeSpread,
  checkFovLimits,
  checkSafeScreenRange,
  checkTargetBoundsCorrespond,
  shouldAdoptArtifact,
  type FovLimits,
  type ScreenRange,
} from './lib/policy';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');

interface Config {
  releaseId: string;
  name: string;
  startup: { build: string; serve: string; url: string; readySelector: string };
  guiEntry: Record<string, unknown> & { reframeButton: string; playButton: string };
  scenario: string;
  requiredActors: string[];
  bodySize: { minHeightSpreadMeters: number; minRadiusSpreadMeters: number };
  targetScreenRange: {
    safeLeft: [number, number];
    safeRightEdge: [number, number];
    safeTop: [number, number];
    safeBottomEdge: [number, number];
    targetInsideSafeTolerancePx: number;
  };
  fovLimits: { verticalMaxDeg: number; horizontalMaxDeg: number; verticalMinDeg: number };
  distanceMax: number;
  marginEdit: { targetPct: number; tolerancePx: number };
  states: Array<{ id: string; label: string; action: string; expect: string }>;
  legacyScenarios: string[];
  artifactPolicy: { adoptOnlyWhen: string; note: string };
}

interface Check {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
}

const configPath = getArg('--config') ?? join(HERE, 'config.json');
const config: Config = JSON.parse(readFileSync(configPath, 'utf8'));

const checks: Check[] = [];
function record(id: string, label: string, ok: boolean, detail: string): void {
  checks.push({ id, label, ok, detail });
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${id} · ${label}${detail ? ` — ${detail}` : ''}`);
}



async function getState(page: Page): Promise<any> {
  return page.evaluate(
    () => (window as unknown as { framingDemo: { getState: () => any } }).framingDemo.getState(),
  );
}

async function waitForSolve(page: Page, prevCount: number, timeout = 10_000): Promise<void> {
  await page.waitForFunction(
    (prev) => {
      const d = (window as unknown as { framingDemo?: { getState: () => any } }).framingDemo;
      if (!d) return false;
      const s = d.getState();
      return s.solveCount > prev && s.dirty === false;
    },
    prevCount,
    { timeout },
  );
}

/** Safe-area screen fractions and target boxes against the configured range. */
function checkFrameGeometry(f: ProbedFrame, tag: string): void {
  const sr = config.targetScreenRange as ScreenRange;
  {
    const v = checkSafeScreenRange(f.safe, f.width, f.height, sr);
    record(`${tag}.safe_range`, '目标屏幕安全区范围', v.ok, v.detail);
  }
  {
    const v = checkTargetBoundsCorrespond(f.targets, f.safe, sr.targetInsideSafeTolerancePx);
    record(`${tag}.target_bounds`, '目标边界与安全区对应', v.ok, v.detail);
  }
  record(
    `${tag}.body_boxes`,
    '包围框为真实身体投影（非点）',
    f.targets.every((t) => t.sampleCount > 200 && (t.pointsBehind > 0 || (t.w > 1 && t.h > 1))),
    f.targets.map((t) => `${t.name} ${Math.round(t.w)}×${Math.round(t.h)}px/${t.sampleCount}${t.pointsBehind ? `(身后${t.pointsBehind})` : ''}`).join(' · '),
  );
}

function checkFov(s: any, tag: string): void {
  const v = checkFovLimits(s.camera, s.constraints, config.fovLimits as FovLimits);
  record(`${tag}.fov_limits`, '视场限制读取', v.ok && s.camera.distance <= config.distanceMax + 1e-6, v.detail);
}

function checkBodySizes(s: any, tag: string): void {
  const presence = checkActorsPresent(config.requiredActors, s.actors);
  record(`${tag}.actors_present`, '角色数据齐全', presence.ok, presence.detail);
  const spread = checkBodySizeSpread(s.actors, config.bodySize);
  record(`${tag}.body_size_spread`, '不同体型部署', spread.ok, spread.detail);
}

async function setMargin(page: Page, side: string, pct: number): Promise<void> {
  await page.locator(`#margin-${side}`).evaluate((el, v) => {
    const input = el as HTMLInputElement;
    input.value = String(v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, pct);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<number> {
  const outDir = resolve(ROOT, getArg('--out') ?? 'evidence');
  mkdirSync(join(outDir, 'shots'), { recursive: true });

  console.log('› build');
  const buildCode = await runOnce(['npm', 'run', 'build']);
  record('build', '生产构建', buildCode === 0, buildCode === 0 ? 'ok' : `exit ${buildCode}`);
  if (buildCode !== 0) return finish(outDir, null);

  console.log('› serve (vite preview)');
  const server = spawn(config.startup.serve.split(' ')[0], config.startup.serve.split(' ').slice(1), {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, BROWSER: 'none' },
  });
  let serverLog = '';
  server.stdout?.on('data', (d) => (serverLog += d.toString()));
  server.stderr?.on('data', (d) => (serverLog += d.toString()));
  const url = config.startup.url;
  const served = await waitForHttp(url, 60_000);
  record('serve', '启动运行配置指向的服务', served, served ? url : serverLog.slice(-400));
  if (!served) {
    server.kill('SIGTERM');
    return finish(outDir, null);
  }

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ args: ['--no-sandbox', '--use-gl=swiftshader'] });
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(`console: ${m.text()}`);
    });
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForFunction(
      () => Boolean((window as unknown as { framingDemo?: unknown }).framingDemo),
      undefined,
      { timeout: 15_000 },
    );
    await page.waitForSelector(config.startup.readySelector, { state: 'visible' });

    // ----- deployment scenario, via the real select element -----------------
    console.log('› deployment scenario');
    await page.selectOption('#scenario-select', config.scenario);
    await page.selectOption('#aspect-select', String(16 / 9));
    await page.waitForTimeout(400);
    let cur = await getState(page);
    record(
      'boot.controller',
      '控制器实际执行（非预设机位）',
      typeof cur.solveCount === 'number' && cur.solveCount > 0 && Boolean(cur.camera),
      `solves=${cur.solveCount} scenario=${cur.scenario} status=${cur.status}`,
    );
    const baseMargins: Record<string, number> = { ...cur.constraints.margins };

    checkBodySizes(cur, 'initial');
    checkFov(cur, 'initial');
    checkFrameGeometry(await probeFrame(page), 'initial');
    record(
      'initial.fitted',
      '聚合状态完整入画',
      cur.status === 'fitted' && cur.reports.every((r: any) => r.insideSafe),
      `status=${cur.status} in=${cur.reports.filter((r: any) => r.insideSafe).length}/${cur.reports.length}`,
    );
    await page.screenshot({ path: join(outDir, 'shots', '01-cluster.png') });

    // ----- GUI reframe button ------------------------------------------------
    console.log('› GUI reframe button');
    {
      const s0 = await getState(page);
      await page.click('#reframe-button');
      await waitForSolve(page, s0.solveCount);
      const s1 = await getState(page);
      record(
        'gui.reframe',
        '界面按钮调用共同取景实现',
        s1.solveCount > s0.solveCount && Boolean(s1.camera) && s1.status === 'fitted',
        `solve ${s0.solveCount}→${s1.solveCount} status=${s1.status} bounds=${s1.reports.length} actors`,
      );
    }

    // ----- GUI margin edit ---------------------------------------------------
    console.log('› GUI margin edit');
    {
      const beforeF = await probeFrame(page);
      const target = config.marginEdit.targetPct;
      for (const side of ['left', 'right', 'top', 'bottom']) await setMargin(page, side, target);
      await page.waitForTimeout(600);
      const afterF = await probeFrame(page);
      const s = await getState(page);
      const grew =
        afterF.marginsPx.left > beforeF.marginsPx.left + config.marginEdit.tolerancePx &&
        afterF.marginsPx.top > beforeF.marginsPx.top + config.marginEdit.tolerancePx;
      record(
        'gui.margins',
        '界面滑杆改边距参与求解',
        grew && s.constraints.margins.left > 0.1 && s.status === 'fitted',
        `leftPx ${beforeF.marginsPx.left.toFixed(1)}→${afterF.marginsPx.left.toFixed(1)} topPx ${beforeF.marginsPx.top.toFixed(1)}→${afterF.marginsPx.top.toFixed(1)} margin=${s.constraints.margins.left.toFixed(3)}`,
      );
      await page.screenshot({ path: join(outDir, 'shots', '02-margins.png') });
      for (const side of ['left', 'right', 'top', 'bottom']) {
        await setMargin(page, side, Math.round(baseMargins[side] * 100));
      }
      await page.waitForTimeout(500);
    }

    // ----- drag multiple actors in the canvas --------------------------------
    console.log('› canvas drag of multiple actors');
    {
      const s0 = await getState(page);
      const movedIds = new Set<string>();
      // Box centres can sit behind a nearer body, so a blind click may grab the
      // wrong actor. Scan points inside the target's own screen box, press, and
      // read back which actor the real picker selected before committing to a
      // drag. This keeps the interaction a genuine pointer drag on the canvas.
      const stage = await page.evaluate(() => {
        const r = (document.getElementById('stage-frame') as HTMLElement).getBoundingClientRect();
        return { x: r.x, y: r.y };
      });
      for (const t of [...(await probeFrame(page)).targets].sort((a, b) => b.w * b.h - a.w * a.h)) {
        if (movedIds.size >= 2) break;
        if (t.w < 16 || t.h < 16 || !Number.isFinite(t.w)) continue;
        let grabbed = false;
        const start = await getState(page);
        // The drag plane is the actor's foot plane, so only rays angled down
        // intersect it. Grab the lower part of the body first (rows near the
        // feet), then work upward if the lower body is occluded.
        outer: for (let gy = 5; gy >= 1; gy--) {
          for (let gx = 1; gx <= 4; gx++) {
            const px = stage.x + t.x + (t.w * gx) / 5;
            const py = stage.y + t.y + (t.h * gy) / 6;
            await page.mouse.move(px, py);
            await page.mouse.down();
            const sel = (await getState(page)).selectedId;
            if (sel === t.id) {
              const dir = Math.sign(t.x + t.w / 2 - (await probeFrame(page)).width / 2) || 1;
              await page.mouse.move(px + dir * 110, py, { steps: 14 });
              await page.mouse.up();
              await page.waitForTimeout(320);
              grabbed = true;
              break outer;
            }
            await page.mouse.up();
            await page.waitForTimeout(30);
          }
        }
        if (!grabbed) continue;
        const post = await getState(page);
        for (const a of post.actors) {
          const b = start.actors.find((x: any) => x.id === a.id);
          if (b && Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z) > 0.05) {
            movedIds.add(a.id);
          }
        }
      }
      const s1 = await getState(page);
      record(
        'gui.drag_multi',
        '画布内移动多名角色并重解',
        movedIds.size >= 2 && s1.solveCount > s0.solveCount,
        `移动 ${[...movedIds].join(',') || '无'} · solves ${s0.solveCount}→${s1.solveCount}`,
      );
      checkFrameGeometry(await probeFrame(page), 'dragged');
      await page.screenshot({ path: join(outDir, 'shots', '03-dragged.png') });
    }

    // ----- real-time playback runner ----------------------------------------
    console.log('› real-time playback');
    {
      await page.selectOption('#scenario-select', config.scenario);
      await page.waitForTimeout(400);
      await page.evaluate(() => (window as unknown as { framingDemo: any }).framingDemo.playBeat(0));
      const p0 = (await getState(page)).camera.position;
      const a0 = (await getState(page)).actors.map((a: any) => ({ ...a.position }));
      await page.click('#play-button');
      // Sample across the whole first-beat + disperse-beat window so the
      // moving beat is covered, not just the static opening beat.
      const samples: Array<{ pos: { x: number; y: number; z: number }; status: string }> = [];
      for (let i = 0; i < 16; i++) {
        await page.waitForTimeout(150);
        const s = await getState(page);
        samples.push({ pos: s.camera.position, status: s.status });
      }
      await page.click('#play-button'); // pause
      const movedStates = samples.filter((s) => s.status === 'fitted' || s.status === 'tradeoff').length;
      const cameraDelta = samples.filter(
        (s) => Math.hypot(s.pos.x - p0.x, s.pos.y - p0.y, s.pos.z - p0.z) > 0.01,
      ).length;
      const finalA = (await getState(page)).actors;
      const actorsMoved = finalA.some((a: any, i: number) => {
        const b = a0[i];
        return b && Math.hypot(a.position.x - b.x, a.position.z - b.z) > 0.1;
      });
      record(
        'realtime.playback',
        '实时相机运行器逐帧重解',
        cameraDelta >= 5 && actorsMoved && movedStates === samples.length,
        `${cameraDelta}/${samples.length} 帧相机移动 · 角色位移=${actorsMoved ? '有' : '无'} · 状态 ${[...new Set(samples.map((s) => s.status))].join('/')}`,
      );
    }

    // ----- dispersed state --------------------------------------------------
    console.log('› dispersed state');
    {
      // playBeat(i) snaps to the end of beat i; beat 1 ends dispersed.
      await page.evaluate(() => (window as unknown as { framingDemo: any }).framingDemo.playBeat(1));
      await page.waitForTimeout(600);
      const s = await getState(page);
      record(
        'dispersed.tradeoff',
        '目标分散触发显式取舍',
        s.status === 'tradeoff' &&
          Boolean(s.tradeoff) &&
          s.camera.fovDeg <= config.fovLimits.verticalMaxDeg + 1e-6,
        `status=${s.status} fov=${s.camera.fovDeg.toFixed(1)} clipped=${(s.tradeoff?.clippedActors ?? []).join(',') || 'none'}`,
      );
      checkFov(s, 'dispersed');
      const frame = await probeFrame(page);
      checkFrameGeometry(frame, 'dispersed');
      record(
        'dispersed.outside_safe',
        '取舍时确有目标越过安全区（真实边界）',
        frame.targets.some((t) => !t.insideSafe) && s.reports.some((r: any) => !r.insideSafe),
        frame.targets.map((t) => `${t.id}:${t.insideSafe ? 'in' : 'out'}`).join(' '),
      );
      await page.screenshot({ path: join(outDir, 'shots', '04-dispersed.png') });
      writeFileSync(
        join(outDir, 'dispersed-state.json'),
        JSON.stringify(
          {
            camera: s.camera,
            safe: s.safe,
            status: s.status,
            reports: s.reports.map((r: any) => ({ id: r.id, insideSafe: r.insideSafe, maxOverflow: r.maxOverflow })),
            actors: s.actors,
          },
          null,
          2,
        ),
      );

      const s0 = await getState(page);
      await page.click('#reframe-button');
      await waitForSolve(page, s0.solveCount);
      const s1 = await getState(page);
      record(
        'gui.reframe_dispersed',
        '界面按钮在分散态复算仍为取舍',
        s1.solveCount > s0.solveCount && s1.status === 'tradeoff',
        `status=${s1.status} solves ${s0.solveCount}→${s1.solveCount}`,
      );
    }

    // ----- re-cluster -------------------------------------------------------
    console.log('› re-cluster');
    {
      await page.evaluate(() => (window as unknown as { framingDemo: any }).framingDemo.playBeat(2));
      await page.waitForTimeout(600);
      const s = await getState(page);
      record(
        'recluster.fitted',
        '重新聚合恢复完整入画',
        s.status === 'fitted' && s.reports.every((r: any) => r.insideSafe),
        `status=${s.status} in=${s.reports.filter((r: any) => r.insideSafe).length}/${s.reports.length}`,
      );
      checkFrameGeometry(await probeFrame(page), 'recluster');
      await page.screenshot({ path: join(outDir, 'shots', '05-recluster.png') });
    }

    // ----- legacy sample runs to the end ------------------------------------
    console.log('› legacy scenarios to the end');
    for (const id of config.legacyScenarios) {
      await page.selectOption('#scenario-select', id);
      await page.waitForTimeout(400);
      const info = await getState(page);
      const results: string[] = [];
      let ok = true;
      for (let b = 0; b < info.beatCount; b++) {
        await page.evaluate((idx) => (window as unknown as { framingDemo: any }).framingDemo.playBeat(idx), b);
        await page.waitForTimeout(220);
        const s = await getState(page);
        const finite = Number.isFinite(s.camera.position.x) && Number.isFinite(s.camera.fovDeg);
        const beatOk = finite && (s.status === 'fitted' || s.status === 'tradeoff');
        results.push(`b${b + 1}:${s.status}${beatOk ? '' : '!'}`);
        ok = ok && beatOk;
      }
      record(`legacy.${id}`, `旧样例 ${id} 运行到底`, ok, results.join(' '));
    }

    record('runtime.errors', '运行期无页面错误', errors.length === 0, errors.slice(0, 4).join(' | ') || 'none');
    await page.close();
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
    await sleep(300);
    if (!server.killed) server.kill('SIGKILL');
  }

  return finish(outDir, url);
}

function finish(outDir: string, url: string | null): number {
  const pass = shouldAdoptArtifact(checks);
  const provenance = sourceProvenance();
  const summary = {
    releaseId: config.releaseId,
    name: config.name,
    generatedAt: new Date().toISOString(),
    url,
    provenance,
    pass,
    adopt: pass ? 'allowed' : 'forbidden',
    artifactPolicy: config.artifactPolicy,
    totals: {
      total: checks.length,
      passed: checks.filter((c) => c.ok).length,
      failed: checks.filter((c) => !c.ok).length,
    },
    checks,
  };
  writeFileSync(join(outDir, 'evidence.json'), JSON.stringify(summary, null, 2));
  writeFileSync(join(outDir, 'evidence.md'), renderMarkdown(summary));
  console.log(`\n${pass ? 'RELEASE PASS' : 'RELEASE FAIL'} — ${summary.totals.passed}/${summary.totals.total} checks`);
  console.log(`evidence → ${outDir}`);
  return pass ? 0 : 1;
}

function renderMarkdown(s: {
  releaseId: string;
  name: string;
  generatedAt: string;
  url: string | null;
  provenance: Record<string, string>;
  pass: boolean;
  adopt: string;
  artifactPolicy: { adoptOnlyWhen: string; note: string };
  totals: { total: number; passed: number; failed: number };
  checks: Check[];
}): string {
  const lines: string[] = [];
  lines.push(`# 共同取景发行证据 · ${s.name}`);
  lines.push('');
  lines.push(`- 发行编号：\`${s.releaseId}\``);
  lines.push(`- 生成时间：${s.generatedAt}`);
  lines.push(`- 运行地址：${s.url ?? '—'}`);
  lines.push(`- 执行目录：${s.provenance.mode}${s.provenance.sourceRev ? ` · 源码 \`${s.provenance.sourceRev}\`` : ''}`);
  lines.push(`- 结论：**${s.pass ? 'PASS（可采纳产物）' : 'FAIL（禁止采用产物）'}** · 产物采纳：${s.adopt === 'allowed' ? '允许' : '禁止'}`);
  lines.push(`- 通过：${s.totals.passed}/${s.totals.total}`);
  lines.push(`- 产物策略：${s.artifactPolicy.note}`);
  lines.push('');
  lines.push('| 检查 | 项 | 结果 | 细节 |');
  lines.push('| --- | --- | --- | --- |');
  for (const c of s.checks) {
    lines.push(`| \`${c.id}\` | ${c.label} | ${c.ok ? '通过' : '失败'} | ${c.detail.replace(/\|/g, '\\|')} |`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Where the artifact under test came from. The clean-dir script sets
 * RELEASE_CLEAN_DIR=1 and RELEASE_SOURCE_REV=<commit>, so the raw record can be
 * traced back to an exact revision instead of an anonymous working tree.
 */
function sourceProvenance(): Record<string, string> {
  const rev = process.env.RELEASE_SOURCE_REV ?? git(['rev-parse', 'HEAD']) ?? 'unknown';
  const dirty = process.env.RELEASE_SOURCE_REV ? 'no' : (git(['status', '--porcelain']) ? 'yes' : 'no');
  return {
    mode: process.env.RELEASE_CLEAN_DIR === '1' ? '净目录（临时副本）' : '工作树',
    sourceRev: rev,
    workingTreeDirty: dirty,
    releaseRoot: ROOT,
  };
}

function git(args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

function getArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function runOnce(cmd: string[]): Promise<number> {
  return new Promise((resolvePromise) => {
    const p: ChildProcess = spawn(cmd[0], cmd.slice(1), { cwd: ROOT, stdio: 'inherit', shell: false });
    p.on('exit', (code) => resolvePromise(code ?? 1));
    p.on('error', () => resolvePromise(1));
  });
}

async function waitForHttp(url: string, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await sleep(400);
  }
  return false;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('RELEASE RUNNER ERROR', err);
    process.exit(2);
  });
