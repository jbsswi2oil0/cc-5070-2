import { test, expect, type Page } from '@playwright/test';

declare global {
  interface Window {
    framingDemo: {
      getState: () => any;
      selectScenario: (id: string) => void;
      setAspect: (a: number) => void;
      setMargin: (side: 'left' | 'right' | 'top' | 'bottom', pct: number) => void;
      moveActor: (id: string, x: number, y: number, z: number) => void;
      setConstraint: (key: string, value: number) => void;
      playBeat: (i: number) => void;
      setPlaying: (on: boolean) => void;
      tickOnce: (dt: number) => void;
      solve: () => void;
      updateActor: (id: string, patch: Record<string, number | string>) => boolean;
      positionActors: (positions: Array<{ id: string; x: number; y: number; z: number }>) => string[];
      pause: () => void;
    };
  }
}

const state = (page: Page) => page.evaluate(() => window.framingDemo.getState());

async function boot(page: Page): Promise<void> {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto('/');
  await page.waitForFunction(() => Boolean(window.framingDemo));
  await expect(page.locator('#status-line')).toBeVisible();
  (page as unknown as { __errors: string[] }).__errors = errors;
}

test('boots with a solved frame whose body boxes sit inside the safe area', async ({ page }) => {
  await boot(page);
  const s = await state(page);
  expect(s.reports.length).toBe(3);
  expect(s.status).toBe('fitted');
  for (const r of s.reports) {
    expect(r.insideSafe).toBe(true);
    expect(r.maxOverflow).toBeLessThan(0.01);
    // The reported bounding box is the body envelope, never a point.
    expect(r.bboxNdc.right - r.bboxNdc.left).toBeGreaterThan(0);
    expect(r.bboxNdc.top - r.bboxNdc.bottom).toBeGreaterThan(0);
    expect(r.sampleCount).toBeGreaterThan(200);
  }
  expect((page as unknown as { __errors: string[] }).__errors).toEqual([]);
});

test('letterboxes the stage to the selected aspect ratio', async ({ page }) => {
  await boot(page);
  const wide = await page.evaluate(() => {
    const r = document.getElementById('stage-frame')!.getBoundingClientRect();
    return r.width / r.height;
  });
  expect(Math.abs(wide - 16 / 9)).toBeLessThan(0.02);

  await page.selectOption('#aspect-select', String(9 / 16));
  await page.waitForTimeout(500);
  const portrait = await page.evaluate(() => {
    const r = document.getElementById('stage-frame')!.getBoundingClientRect();
    return r.width / r.height;
  });
  expect(Math.abs(portrait - 9 / 16)).toBeLessThan(0.03);
  const s = await state(page);
  expect(s.status).toBe('fitted');
  // Portrait pushes the camera back, so the distance must grow.
  expect(s.camera.distance).toBeGreaterThan(8);
});

test('moving an actor through the solver keeps every report inside its bounds', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.framingDemo.moveActor('qiao', 4.2, 1.15, 4.6));
  await page.waitForTimeout(400);
  const s = await state(page);
  const moved = s.actors.find((a: { id: string }) => a.id === 'qiao');
  expect(moved.position.x).toBeCloseTo(4.2, 5);
  expect(s.status).toBe('fitted');
  for (const r of s.reports) expect(r.insideSafe).toBe(true);
});

test('widening all four margins pushes the camera back and keeps the fit', async ({ page }) => {
  await boot(page);
  const before = (await state(page)).camera.distance;
  for (const side of ['left', 'right', 'top', 'bottom'] as const) {
    await page.evaluate((s) => window.framingDemo.setMargin(s, 18), side);
  }
  await page.waitForTimeout(500);
  const s = await state(page);
  expect(s.camera.distance).toBeGreaterThan(before);
  for (const r of s.reports) expect(r.insideSafe).toBe(true);
});

test('reports an explicit tradeoff instead of exceeding the fov cap', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.framingDemo.selectScenario('wide-spread'));
  await page.waitForTimeout(500);
  const s = await state(page);
  expect(s.status).toBe('tradeoff');
  expect(s.lensMode).toBe('tradeoff');
  // The hard cap is never exceeded...
  expect(s.camera.fovDeg).toBeLessThanOrEqual(s.constraints.fovMaxDeg + 1e-6);
  expect(s.camera.distance).toBeLessThanOrEqual(s.constraints.distanceMax + 1e-6);
  // ...and the tradeoff text names what was sacrificed.
  expect(s.tradeoff.summary.length).toBeGreaterThan(10);
  expect(s.tradeoff.clippedActors.length).toBeGreaterThan(0);
  await expect(page.locator('#tradeoff-card')).toBeVisible();
  await expect(page.locator('#status-line')).toContainText('取舍');
});

test('playback moves the actors continuously and stays solved each step', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.framingDemo.playBeat(1));
  await page.waitForTimeout(300);
  const poses: Array<{ x: number; y: number; z: number }> = [];
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => window.framingDemo.tickOnce(90));
    const s = await state(page);
    poses.push(s.camera.position);
    for (const r of s.reports) expect(r.maxOverflow).toBeLessThan(0.02);
  }
  let maxJump = 0;
  for (let i = 1; i < poses.length; i++) {
    const a = poses[i - 1];
    const b = poses[i];
    maxJump = Math.max(maxJump, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z));
  }
  // No teleporting between sampled steps of a beat.
  expect(maxJump).toBeLessThan(1.5);
});

test('dragging an actor in the canvas moves it and re-solves the group', async ({ page }) => {
  await boot(page);
  const before = await state(page);
  const target = before.reports.find((r: { id: string }) => r.id === 'rui');
  const frame = await page.evaluate(() => {
    const r = document.getElementById('stage-frame')!.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const toScreen = (ndc: { x: number; y: number }) => ({
    x: frame.x + ((ndc.x + 1) / 2) * frame.w,
    y: frame.y + ((1 - ndc.y) / 2) * frame.h,
  });
  const center = {
    x: (target.bboxNdc.left + target.bboxNdc.right) / 2,
    y: (target.bboxNdc.top + target.bboxNdc.bottom) / 2,
  };
  const from = toScreen(center);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 140, from.y, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(500);

  const after = await state(page);
  const beforeActor = before.actors.find((a: { id: string }) => a.id === 'rui');
  const afterActor = after.actors.find((a: { id: string }) => a.id === 'rui');
  const moved = Math.hypot(
    afterActor.position.x - beforeActor.position.x,
    afterActor.position.z - beforeActor.position.z,
  );
  expect(moved).toBeGreaterThan(0.25);
  expect(after.camera.distance).not.toBeCloseTo(before.camera.distance, 6);
  for (const r of after.reports) expect(r.maxOverflow).toBeLessThan(0.02);
});

test('applying the suggested caps turns the tradeoff into a full fit', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.framingDemo.selectScenario('wide-spread'));
  await page.waitForTimeout(500);
  expect((await state(page)).status).toBe('tradeoff');

  await page.evaluate(() => {
    document.querySelector('.panel-column')!.scrollTop = 10000;
  });
  await page.click('#apply-suggestion');
  await page.waitForTimeout(700);
  const s = await state(page);
  expect(s.status).toBe('fitted');
  for (const r of s.reports) expect(r.insideSafe).toBe(true);
  expect(s.camera.fovDeg).toBeLessThanOrEqual(s.constraints.fovMaxDeg + 1e-6);
});

test('a replayed hash restores the same actors, constraints and beat', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.framingDemo.moveActor('lin', 1.1, 0, 2.2));
  await page.evaluate(() => window.framingDemo.setMargin('left', 12));
  await page.waitForTimeout(400);
  const hash = await page.evaluate(() => location.hash);
  expect(hash.length).toBeGreaterThan(10);

  await page.goto(`/${hash}`);
  await page.waitForFunction(() => Boolean(window.framingDemo));
  await page.waitForTimeout(400);
  const s = await state(page);
  expect(s.actors.find((a: { id: string }) => a.id === 'lin').position.x).toBeCloseTo(1.1, 4);
  expect(s.constraints.margins.left).toBeCloseTo(0.12, 4);
  expect(s.status).toBe('fitted');
});

test('the reframe button re-runs the shared-framing controller', async ({ page }) => {
  await boot(page);
  const before = await state(page);
  // The button must go through the same solve path as drags/margins, so a press
  // increments the controller's solve count and keeps the frame fitted.
  await page.click('#reframe-button');
  await page.waitForTimeout(500);
  const after = await state(page);
  expect(after.solveCount).toBeGreaterThan(before.solveCount);
  expect(after.status).toBe('fitted');
  expect(after.reports.length).toBe(before.reports.length);

  // Dropping an actor from the cast and pressing reframe must reflect the new
  // cast — the button reads live state, not a canned frame.
  await page.evaluate(() => window.framingDemo.selectScenario('deployment'));
  await page.waitForTimeout(400);
  await page.click('#reframe-button');
  await page.waitForTimeout(500);
  const dep = await state(page);
  expect(dep.scenario).toBe('deployment');
  expect(dep.actors.length).toBe(4);
});

test('the target-bounds read-out mirrors the solver evaluation', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.framingDemo.selectScenario('deployment'));
  await page.waitForTimeout(500);
  const s = await state(page);
  const readout = await page.locator('#target-bounds').innerText();
  // The union of every body envelope is shown, and it is the solver's numbers.
  const union = s.reports.reduce(
    (acc: any, r: any) => ({
      left: Math.min(acc.left, r.bboxNdc.left),
      right: Math.max(acc.right, r.bboxNdc.right),
      bottom: Math.min(acc.bottom, r.bboxNdc.bottom),
      top: Math.max(acc.top, r.bboxNdc.top),
    }),
    { left: Infinity, right: -Infinity, bottom: Infinity, top: -Infinity },
  );
  expect(readout).toContain(union.left.toFixed(3));
  expect(readout).toContain(union.right.toFixed(3));
  expect(readout).toContain('全部目标边界位于安全区内');

  // Dispersing the cast must flip the read-out to the overflow verdict.
  await page.evaluate(() => window.framingDemo.playBeat(1));
  await page.waitForTimeout(500);
  const dispersed = await state(page);
  const readout2 = await page.locator('#target-bounds').innerText();
  expect(dispersed.status).toBe('tradeoff');
  expect(readout2).toContain('越过安全区');
});

test('deployment demo runs clustered → dispersed → clustered with real solves', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.framingDemo.selectScenario('deployment'));
  await page.waitForTimeout(400);
  const clustered = await state(page);
  expect(clustered.status).toBe('fitted');

  await page.evaluate(() => window.framingDemo.playBeat(1));
  await page.waitForTimeout(500);
  const spread = await state(page);
  expect(spread.status).toBe('tradeoff');
  expect(spread.camera.fovDeg).toBeLessThanOrEqual(spread.constraints.fovMaxDeg + 1e-6);

  await page.evaluate(() => window.framingDemo.playBeat(2));
  await page.waitForTimeout(500);
  const again = await state(page);
  expect(again.status).toBe('fitted');
  for (const r of again.reports) expect(r.insideSafe).toBe(true);
});

test('body sizes are varied and editable through the actor hook', async ({ page }) => {
  await boot(page);
  await page.evaluate(() => window.framingDemo.selectScenario('deployment'));
  await page.waitForTimeout(400);
  const s = await state(page);
  const heights = s.actors.map((a: any) => a.height);
  const radii = s.actors.map((a: any) => a.radius);
  expect(Math.max(...heights) - Math.min(...heights)).toBeGreaterThan(0.45);
  expect(Math.max(...radii) - Math.min(...radii)).toBeGreaterThan(0.15);

  await page.evaluate(() => window.framingDemo.updateActor('short', { height: 2.2, radius: 0.5 }));
  await page.waitForTimeout(400);
  const after = await state(page);
  const short = after.actors.find((a: any) => a.id === 'short');
  expect(short.height).toBeCloseTo(2.2, 3);
  expect(short.radius).toBeCloseTo(0.5, 3);
  // A taller, wider body changes the envelope, so the solve must still report.
  expect(after.camera.fovDeg).toBeLessThanOrEqual(after.constraints.fovMaxDeg + 1e-6);
});
