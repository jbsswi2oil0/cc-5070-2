import type { Actor, FramingConstraints, SolverParams } from '../framing/types';
import { solveFraming, type SolveResult } from '../framing/solver';
import { marginLabels } from '../framing/caps';
import { Stage } from './stage';
import { drawDiagnosticOverlay } from './overlay';
import { drawPlanView } from './planview';
import { ASPECT_PRESETS, scenarioById, scenarios, type DemoBeat, type Scenario } from './scenarios';
import { applyOverrides, decodeSnapshot, encodeSnapshot, overridesFromConstraints, type OverrideState, type ScenarioSnapshot } from './overrides';

interface AppState {
  scenario: Scenario;
  actors: Actor[];
  overrides: OverrideState;
  aspect: number;
  constraints: FramingConstraints;
  result: SolveResult | null;
  previousParams: SolverParams | null;
  beatIndex: number;
  beatT: number;
  playing: boolean;
  selectedId: string | null;
  hoveredId: string | null;
  showPlan: boolean;
  dirty: boolean;
  solveCount: number;
  lastSolveAt: number;
}

interface Dom {
  canvas: HTMLCanvasElement;
  overlay: HTMLCanvasElement;
  plan: HTMLCanvasElement;
  planWrap: HTMLElement;
  viewport: HTMLElement;
  stageFrame: HTMLElement;
  scenarioSelect: HTMLSelectElement;
  scenarioSubtitle: HTMLElement;
  aspectSelect: HTMLSelectElement;
  yaw: HTMLInputElement;
  yawLabel: HTMLElement;
  workingFov: HTMLInputElement;
  workingFovLabel: HTMLElement;
  fovMax: HTMLInputElement;
  fovMaxLabel: HTMLElement;
  hFovMax: HTMLInputElement;
  hFovMaxLabel: HTMLElement;
  distanceMax: HTMLInputElement;
  distanceMaxLabel: HTMLElement;
  marginInputs: Record<MarginSide, HTMLInputElement>;
  marginLabels: Record<MarginSide, HTMLElement>;
  playButton: HTMLButtonElement;
  replayButton: HTMLButtonElement;
  resetButton: HTMLButtonElement;
  stepButtons: HTMLButtonElement[];
  progressFill: HTMLElement;
  beatLabel: HTMLElement;
  beatNotes: HTMLElement;
  statusLine: HTMLElement;
  targetBounds: HTMLElement;
  reframeButton: HTMLButtonElement;
  resultGrid: HTMLElement;
  tradeoffCard: HTMLElement;
  tradeoffBody: HTMLElement;
  tradeoffTags: HTMLElement;
  suggestionCard: HTMLElement;
  suggestionBody: HTMLElement;
  applySuggestion: HTMLButtonElement;
  actorRows: HTMLElement;
  actorCount: HTMLElement;
  inspector: HTMLElement;
  inspectorName: HTMLElement;
  inspectorColor: HTMLElement;
  actorName: HTMLInputElement;
  actorX: HTMLInputElement;
  actorY: HTMLInputElement;
  actorZ: HTMLInputElement;
  actorHeight: HTMLInputElement;
  actorImportance: HTMLInputElement;
  actorRadius: HTMLInputElement;
  togglePlan: HTMLButtonElement;
  copyLink: HTMLButtonElement;
  pipeline: HTMLElement;
}

type MarginSide = 'left' | 'right' | 'top' | 'bottom';

export function mountApp(root: HTMLElement): void {
  root.innerHTML = template();
  const dom = collect(root);

  const initial = decodeSnapshot(location.hash);
  const scenario = scenarioById(initial?.scenario ?? 'plaza');
  const aspect = initial?.aspect ?? 16 / 9;
  const overrides = initial?.overrides ?? overridesFromConstraints({ ...scenario.constraints, aspect });

  const state: AppState = {
    scenario,
    actors: cloneActors(scenario.actors, initial),
    overrides,
    aspect,
    constraints: applyOverrides({ ...scenario.constraints, aspect }, overrides),
    result: null,
    previousParams: null,
    beatIndex: initial?.beatIndex ?? 0,
    beatT: 0,
    playing: false,
    selectedId: null,
    hoveredId: null,
    showPlan: true,
    dirty: true,
    solveCount: 0,
    lastSolveAt: 0,
  };
  if (state.beatIndex > 0) {
    const positions = beatStartPositions(scenario, state.beatIndex);
    for (const a of state.actors) {
      const p = positions[a.id];
      if (p) a.position = { x: p[0], y: p[1], z: p[2] };
    }
  }

  const labelLayer = dom.stageFrame.querySelector('#actor-labels') as HTMLDivElement;
  const stage = new Stage(dom.canvas, labelLayer);

  stage.onActorSelect = (id) => {
    state.selectedId = id || null;
    stage.setSelected(state.selectedId);
    renderActorInspector();
    renderResults();
  };
  stage.onActorDrag = (id, position) => {
    const actor = state.actors.find((a) => a.id === id);
    if (!actor) return;
    actor.position = position;
    state.selectedId = id;
    state.playing = false;
    stage.setSelected(id);
    state.dirty = true;
  };
  stage.onActorDragEnd = () => {
    state.playing = false;
    renderTransport();
  };

  // ----- solve -----------------------------------------------------------
  let queued = false;
  function requestSolve(): void {
    state.dirty = true;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      if (state.dirty) solveNow();
    });
  }

  function solveNow(): void {
    const res = solveFraming(state.actors, state.constraints, {
      previousParams: state.previousParams ?? undefined,
    });
    state.result = res;
    state.previousParams = res.camera.params;
    state.dirty = false;
    state.solveCount += 1;
    state.lastSolveAt = performance.now();
    layoutFrame();
    stage.setActors(state.actors);
    stage.applySolution(res.camera, state.aspect);
    stage.setSafeRect(res.safe);
    stage.setSelected(state.selectedId);
    renderAll();
  }

  // ----- render ----------------------------------------------------------
  /**
   * Letterbox the stage to the chosen aspect ratio. The solved lens assumes
   * exactly this aspect, so letting the canvas stretch to fill the whole panel
   * would misrepresent the framing on any non-16:9 preset.
   */
  function layoutFrame(): void {
    const vw = dom.viewport.clientWidth;
    const vh = dom.viewport.clientHeight;
    if (vw < 4 || vh < 4) return;
    const a = state.aspect;
    let w = vw;
    let h = w / a;
    if (h > vh) {
      h = vh;
      w = h * a;
    }
    dom.stageFrame.style.width = `${Math.round(w)}px`;
    dom.stageFrame.style.height = `${Math.round(h)}px`;
    stage.resize();
  }

  function renderAll(): void {
    renderResults();
    renderTransport();
    drawOverlays();
    updateReplayHash();
  }

  function drawOverlays(): void {
    const res = state.result;
    if (!res) return;
    stage.updateLabels(res.camera);
    const rect = dom.stageFrame.getBoundingClientRect();
    drawDiagnosticOverlay(dom.overlay, {
      width: rect.width,
      height: rect.height,
      camera: res.camera,
      safe: res.safe,
      reports: res.evaluation.actors.map((a) => a.report),
      actorIds: state.actors.map((a) => a.id),
    });
    if (state.showPlan) {
      drawPlanView(dom.plan, {
        actors: state.actors,
        camera: res.camera,
        constraints: res.constraints,
        safe: res.safe,
        result: res,
        hoveredId: state.hoveredId,
      });
    }
  }

  function renderResults(): void {
    const res = state.result;
    if (!res) return;
    const c = res.camera;
    const insideCount = res.evaluation.actors.filter((a) => a.report.insideSafe).length;
    const statusText =
      res.status === 'fitted'
        ? res.lensMode === 'working'
          ? '完全入画 · 工作镜头'
          : '完全入画 · 已在上限内放宽'
        : '约束取舍';
    dom.statusLine.dataset.status = res.status;
    dom.statusLine.innerHTML = `<span class="status-dot"></span><strong>${statusText}</strong><span class="status-sub">${insideCount}/${res.evaluation.actors.length} 角色完整位于安全区</span>`;

    // Target bounds come from the dense projection reports, so the readout is a
    // restatement of what the kernel measured, never an independent guess.
    const union = res.evaluation.union;
    const outSides: string[] = [];
    if (union.left < res.safe.left - 1e-3) outSides.push('左');
    if (union.right > res.safe.right + 1e-3) outSides.push('右');
    if (union.top > res.safe.top + 1e-3) outSides.push('上');
    if (union.bottom < res.safe.bottom + 1e-3) outSides.push('下');
    const wPct = ((union.right - union.left) / 2) * 100;
    const hPct = ((union.top - union.bottom) / 2) * 100;
    dom.targetBounds.innerHTML = `
      <span class="target-bounds-head">目标边界（全部角色包络并集）</span>
      <span class="target-bounds-row"><b>X</b> ${union.left.toFixed(3)} → ${union.right.toFixed(3)} · <b>Y</b> ${union.bottom.toFixed(3)} → ${union.top.toFixed(3)} <span class="muted">NDC</span></span>
      <span class="target-bounds-row">画幅占比 ${wPct.toFixed(1)}% × ${hPct.toFixed(1)}% · 安全区 ${res.safe.left.toFixed(2)}…${res.safe.right.toFixed(2)} / ${res.safe.bottom.toFixed(2)}…${res.safe.top.toFixed(2)}</span>
      <span class="target-bounds-row ${outSides.length ? 'is-over' : 'is-in'}">${outSides.length ? `越过安全区：${outSides.join(' / ')}` : '全部目标边界位于安全区内'}</span>`;
    dom.targetBounds.dataset.overflow = String(outSides.length > 0);

    dom.resultGrid.innerHTML = [
      cell('相机位置', `${c.position.x.toFixed(2)}, ${c.position.y.toFixed(2)}, ${c.position.z.toFixed(2)}`, 'm · 机位'),
      cell('朝向', `偏航 ${c.yawDeg.toFixed(1)}° · 俯仰 ${c.pitchDeg.toFixed(1)}°`, '水平视线无滚转'),
      cell(
        '实际视场',
        `${c.fovDeg.toFixed(1)}° V · ${c.horizontalFovDeg.toFixed(1)}° H`,
        `硬上限 ${res.caps.verticalFovCapDeg.toFixed(1)}° / ${res.constraints.horizontalFovMaxDeg.toFixed(0)}°`,
      ),
      cell('距离', `${c.distance.toFixed(2)} m`, `${res.constraints.distanceMin.toFixed(1)}–${res.constraints.distanceMax.toFixed(1)} m`),
      cell('完整入画所需', `${res.requiredFovDeg.toFixed(1)}° V · ${res.requiredHorizontalFovDeg.toFixed(1)}° H`, '同一机位下的最小视场'),
      cell('安全边距', marginLabels(res.constraints.margins), '左 / 上 / 右 / 下'),
      cell('画幅', aspectLabel(state.aspect), `${state.aspect.toFixed(3)}`),
      cell('求解评估', `${res.evaluations}`, '候选姿态'),
    ].join('');

    dom.tradeoffCard.hidden = res.status === 'fitted';
    dom.tradeoffTags.innerHTML = (res.tradeoff?.reasonCodes ?? [])
      .map((code) => `<span class="tag tag-warn">${reasonLabel(code)}</span>`)
      .join('');
    dom.tradeoffBody.textContent = res.tradeoff?.summary ?? '';

    dom.suggestionCard.hidden = res.status === 'fitted';
    if (res.suggestion) {
      dom.suggestionBody.innerHTML = `
        <p>仅报告方向，示例不会自动突破上限。如果允许任一项上限放宽，当前构图可以回到完全入画：</p>
        <ul>
          <li>垂直视场上限 → <b>${res.suggestion.verticalFovDeg.toFixed(1)}°</b></li>
          <li>水平视场上限 → <b>${res.suggestion.horizontalFovDeg.toFixed(1)}°</b></li>
          <li>距离上限 → <b>${res.suggestion.distanceMax.toFixed(0)} m</b></li>
        </ul>
        <p class="muted">距离与视场谁更近：<b>${res.suggestion.cheaper === 'fov' ? '视场' : '距离'}</b>。</p>`;
    } else {
      dom.suggestionBody.innerHTML = '';
    }
    dom.applySuggestion.hidden = res.status === 'fitted';

    dom.actorRows.innerHTML = res.evaluation.actors
      .map((a) => {
        const r = a.report;
        const bad = !r.insideSafe || r.pointsBehind > 0;
        const sides = r.clippedSides.length ? r.clippedSides.map(sideLabel).join(' / ') : '—';
        return `<button class="actor-row ${bad ? 'is-clipped' : ''} ${state.selectedId === r.id ? 'is-active' : ''}" data-actor-id="${r.id}">
          <span class="swatch" style="background:${r.color}"></span>
          <span class="actor-row-main">
            <span class="actor-row-name">${escapeHtml(r.name)} <span class="imp">★${r.importance}</span></span>
            <span class="actor-row-meta">覆盖 ${(r.coverage * 100).toFixed(1)}% · 越界 ${sides} · 最大越界 ${(r.maxOverflow * 100).toFixed(1)}% 画面</span>
          </span>
          <span class="pill ${bad ? 'pill-bad' : 'pill-good'}">${bad ? '越界' : '在框内'}</span>
        </button>`;
      })
      .join('');
    dom.actorRows.querySelectorAll<HTMLButtonElement>('.actor-row').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.selectedId = btn.dataset.actorId ?? null;
        stage.setSelected(state.selectedId);
        renderActorInspector();
        renderResults();
        drawOverlays();
      });
    });

    dom.pipeline.textContent = [
      `r ${c.params.r.toFixed(2)} · s ${c.params.s.toFixed(2)} · h ${c.params.h.toFixed(2)} · pitch ${c.params.pitchDeg.toFixed(1)}°`,
      `${res.status === 'fitted' ? '可行解' : '取舍解'}`,
    ].join('  ·  ');
  }

  function renderActorInspector(): void {
    const actor = state.actors.find((a) => a.id === state.selectedId);
    dom.inspector.hidden = !actor;
    if (!actor) return;
    dom.inspectorName.textContent = actor.name;
    dom.inspectorColor.style.background = actor.color;
    dom.actorName.value = actor.name;
    dom.actorX.value = actor.position.x.toFixed(2);
    dom.actorY.value = actor.position.y.toFixed(2);
    dom.actorZ.value = actor.position.z.toFixed(2);
    dom.actorHeight.value = actor.height.toFixed(2);
    dom.actorRadius.value = actor.radius.toFixed(2);
    dom.actorImportance.value = String(actor.importance);
  }

  function renderTransport(): void {
    const beats = state.scenario.beats;
    const current = beats[state.beatIndex];
    dom.beatLabel.textContent = state.playing
      ? `播放中 · ${current?.label ?? ''}`
      : `第 ${state.beatIndex + 1}/${beats.length} 段 · ${current?.label ?? ''}`;
    dom.playButton.textContent = state.playing ? '暂停' : '播放';
    dom.playButton.setAttribute('aria-pressed', String(state.playing));
    dom.progressFill.style.width = `${(state.beatT * 100).toFixed(1)}%`;
    dom.stepButtons.forEach((btn, i) => {
      btn.classList.toggle('is-active', i === state.beatIndex);
      btn.disabled = i >= beats.length;
      btn.hidden = i >= beats.length;
    });
    dom.beatNotes.querySelectorAll<HTMLElement>('li').forEach((li, i) => {
      li.classList.toggle('is-current', i === state.beatIndex);
    });
  }

  // ----- playback --------------------------------------------------------
  function setBeat(index: number, t: number, animate: boolean): void {
    state.beatIndex = index;
    state.beatT = t;
    applyBeat(animate ? t : 1);
    requestSolve();
    renderTransport();
  }

  function applyBeat(t: number): void {
    const beats = state.scenario.beats;
    const beat: DemoBeat = beats[state.beatIndex];
    const start = beatStartPositions(state.scenario, state.beatIndex);
    for (const a of state.actors) {
      const target = beat.moves.find((m) => m.actorId === a.id);
      const from = start[a.id] ?? [a.position.x, a.position.y, a.position.z];
      const to = target ? target.to : from;
      a.position = {
        x: from[0] + (to[0] - from[0]) * t,
        y: from[1] + (to[1] - from[1]) * t,
        z: from[2] + (to[2] - from[2]) * t,
      };
    }
    state.dirty = true;
    stage.setActors(state.actors);
  }

  let last = performance.now();
  function tick(now: number): void {
    const dt = Math.min(64, now - last);
    last = now;
    if (state.playing) {
      const beat = state.scenario.beats[state.beatIndex];
      const progress = Math.min(1, (state.beatT * beat.duration + dt) / beat.duration);
      state.beatT = progress;
      applyBeat(easeInOut(progress));
      if (progress >= 1) {
        if (state.beatIndex < state.scenario.beats.length - 1) {
          state.beatIndex += 1;
          state.beatT = 0;
          applyBeat(0);
        } else {
          state.playing = false;
          state.beatT = 1;
        }
        renderTransport();
      }
      requestSolve();
    }
    if (state.dirty) requestSolve();
    stage.resize();
    stage.render();
    requestAnimationFrame(tick);
  }

  // ----- controls --------------------------------------------------------
  dom.scenarioSelect.innerHTML = scenarios
    .map((s) => `<option value="${s.id}">${s.name}</option>`)
    .join('');
  dom.aspectSelect.innerHTML = ASPECT_PRESETS.map(
    (a) => `<option value="${String(a.value)}">${a.label} · ${a.hint}</option>`,
  ).join('');

  dom.scenarioSelect.addEventListener('change', () => {
    switchScenario(scenarioById(dom.scenarioSelect.value), null);
  });
  dom.aspectSelect.addEventListener('change', () => {
    state.aspect = Number(dom.aspectSelect.value);
    state.constraints = applyOverrides({ ...state.scenario.constraints, aspect: state.aspect }, state.overrides);
    state.previousParams = null;
    requestSolve();
  });

  bindRange(dom.yaw, () => {
    state.overrides.yawDeg = Number(dom.yaw.value);
    commitOverrides();
  });
  bindRange(dom.workingFov, () => {
    state.overrides.workingFovDeg = Number(dom.workingFov.value);
    commitOverrides();
  });
  bindRange(dom.fovMax, () => {
    state.overrides.fovMaxDeg = Number(dom.fovMax.value);
    commitOverrides();
  });
  bindRange(dom.hFovMax, () => {
    state.overrides.horizontalFovMaxDeg = Number(dom.hFovMax.value);
    commitOverrides();
  });
  bindRange(dom.distanceMax, () => {
    state.overrides.distanceMax = Number(dom.distanceMax.value);
    commitOverrides();
  });
  for (const side of ['left', 'right', 'top', 'bottom'] as MarginSide[]) {
    bindRange(dom.marginInputs[side], () => {
      state.overrides.margins[side] = Number(dom.marginInputs[side].value) / 100;
      commitOverrides();
    });
  }

  dom.playButton.addEventListener('click', () => {
    state.playing = !state.playing;
    if (state.playing && state.beatIndex === state.scenario.beats.length - 1 && state.beatT >= 1) {
      restartBeats();
      state.playing = true;
    }
    renderTransport();
  });
  dom.stepButtons.forEach((btn, i) => {
    btn.addEventListener('click', () => {
      state.playing = false;
      setBeat(i, 0, false);
    });
  });
  dom.replayButton.addEventListener('click', () => {
    restartBeats();
    state.playing = true;
    renderTransport();
  });
  dom.resetButton.addEventListener('click', () => switchScenario(state.scenario, null));
  dom.applySuggestion.addEventListener('click', () => {
    const s = state.result?.suggestion;
    if (!s) return;
    state.overrides.fovMaxDeg = Math.max(state.overrides.fovMaxDeg, s.verticalFovDeg);
    state.overrides.horizontalFovMaxDeg = Math.max(state.overrides.horizontalFovMaxDeg, s.horizontalFovDeg);
    state.overrides.distanceMax = Math.max(state.overrides.distanceMax, s.distanceMax);
    syncControls();
    commitOverrides();
  });
  dom.togglePlan.addEventListener('click', () => {
    state.showPlan = !state.showPlan;
    dom.planWrap.hidden = !state.showPlan;
    dom.togglePlan.textContent = state.showPlan ? '隐藏平面示意' : '显示平面示意';
    drawOverlays();
  });
  // Explicit GUI reframe entry: re-run the shared-framing controller on the
  // current actors/constraints. It shares solveNow() with drags, margins and
  // playback, so pressing it cannot diverge from the live solve.
  dom.reframeButton.addEventListener('click', () => {
    state.previousParams = null;
    solveNow();
    flash(dom.reframeButton, '已重新取景');
  });
  dom.copyLink.addEventListener('click', async () => {
    updateReplayHash();
    try {
      await navigator.clipboard.writeText(location.href);
      flash(dom.copyLink, '已复制');
    } catch {
      flash(dom.copyLink, '请手动复制地址栏');
    }
  });

  const commitActor = () => {
    const actor = state.actors.find((a) => a.id === state.selectedId);
    if (!actor) return;
    const name = dom.actorName.value.trim();
    if (name) actor.name = name;
    actor.position = {
      x: Number(dom.actorX.value),
      y: Number(dom.actorY.value),
      z: Number(dom.actorZ.value),
    };
    actor.height = Math.max(0.6, Number(dom.actorHeight.value));
    actor.radius = Math.max(0.1, Number(dom.actorRadius.value));
    actor.importance = Math.max(1, Math.min(5, Math.round(Number(dom.actorImportance.value))));
    stage.setActors(state.actors);
    renderActorInspector();
    requestSolve();
  };
  for (const input of [dom.actorName, dom.actorX, dom.actorY, dom.actorZ, dom.actorHeight, dom.actorRadius, dom.actorImportance]) {
    input.addEventListener('change', commitActor);
  }

  window.addEventListener('resize', () => {
    layoutFrame();
    stage.resize();
    drawOverlays();
  });
  new ResizeObserver(() => {
    layoutFrame();
    stage.resize();
    drawOverlays();
  }).observe(dom.viewport);

  function bindRange(input: HTMLInputElement, fn: () => void): void {
    input.addEventListener('input', () => {
      updateRangeLabels();
      fn();
    });
  }

  function commitOverrides(): void {
    state.constraints = applyOverrides({ ...state.scenario.constraints, aspect: state.aspect }, state.overrides);
    state.previousParams = null;
    requestSolve();
  }

  function switchScenario(sc: Scenario, snapshot: ScenarioSnapshot | null): void {
    state.scenario = sc;
    state.actors = cloneActors(sc.actors, snapshot);
    state.overrides = snapshot?.overrides ?? overridesFromConstraints({ ...sc.constraints, aspect: state.aspect });
    state.constraints = applyOverrides({ ...sc.constraints, aspect: state.aspect }, state.overrides);
    state.aspect = snapshot?.aspect ?? state.aspect;
    state.previousParams = null;
    state.selectedId = null;
    state.beatIndex = snapshot?.beatIndex ?? 0;
    state.beatT = 0;
    state.playing = false;
    if (state.beatIndex > 0) {
      const positions = beatStartPositions(sc, state.beatIndex);
      for (const a of state.actors) {
        const p = positions[a.id];
        if (p) a.position = { x: p[0], y: p[1], z: p[2] };
      }
    }
    dom.scenarioSelect.value = sc.id;
    dom.aspectSelect.value = String(state.aspect);
    syncControls();
    stage.setActors(state.actors);
    stage.setSelected(null);
    renderActorInspector();
    requestSolve();
  }

  function restartBeats(): void {
    state.beatIndex = 0;
    state.beatT = 0;
    state.actors = cloneActors(state.scenario.actors, null);
    applyBeat(0);
    renderTransport();
    requestSolve();
  }

  function syncControls(): void {
    const o = state.overrides;
    dom.yaw.value = String(o.yawDeg);
    dom.workingFov.value = String(o.workingFovDeg);
    dom.fovMax.value = String(o.fovMaxDeg);
    dom.hFovMax.value = String(o.horizontalFovMaxDeg);
    dom.distanceMax.value = String(o.distanceMax);
    for (const side of ['left', 'right', 'top', 'bottom'] as MarginSide[]) {
      dom.marginInputs[side].value = String(Math.round(o.margins[side] * 100));
    }
    dom.scenarioSubtitle.textContent = state.scenario.subtitle;
    dom.beatNotes.innerHTML = state.scenario.beats
      .map((b, i) => `<li data-beat="${i}"><span class="beat-index">${i + 1}</span>${escapeHtml(b.label)}</li>`)
      .join('');
    dom.actorCount.textContent = `${state.actors.length} 名角色`;
    updateRangeLabels();
    renderTransport();
  }

  function updateRangeLabels(): void {
    dom.yawLabel.textContent = `${Math.round(state.overrides.yawDeg)}°`;
    dom.workingFovLabel.textContent = `${Math.round(state.overrides.workingFovDeg)}°`;
    dom.fovMaxLabel.textContent = `${Math.round(state.overrides.fovMaxDeg)}°`;
    dom.hFovMaxLabel.textContent = `${Math.round(state.overrides.horizontalFovMaxDeg)}°`;
    dom.distanceMaxLabel.textContent = `${Math.round(state.overrides.distanceMax)} m`;
    for (const side of ['left', 'right', 'top', 'bottom'] as MarginSide[]) {
      dom.marginLabels[side].textContent = `${Math.round(state.overrides.margins[side] * 100)}%`;
    }
  }

  function updateReplayHash(): void {
    const snap: ScenarioSnapshot = {
      scenario: state.scenario.id,
      aspect: state.aspect,
      beatIndex: state.beatIndex,
      actors: state.actors.map((a) => ({
        id: a.id,
        x: a.position.x,
        y: a.position.y,
        z: a.position.z,
        height: a.height,
        radius: a.radius,
        importance: a.importance,
      })),
      overrides: state.overrides,
    };
    history.replaceState(null, '', `#${encodeSnapshot(snap)}`);
  }

  // ----- boot ------------------------------------------------------------
  dom.aspectSelect.value = String(state.aspect);
  syncControls();
  stage.setActors(state.actors);
  solveNow();
  renderActorInspector();
  requestAnimationFrame(tick);

  (window as unknown as { framingDemo: unknown }).framingDemo = {
    getState: () => ({
      scenario: state.scenario.id,
      aspect: state.aspect,
      actors: state.actors.map((a) => ({
        id: a.id,
        name: a.name,
        position: { ...a.position },
        height: a.height,
        radius: a.radius,
        importance: a.importance,
      })),
      constraints: state.constraints,
      safe: state.result?.safe,
      status: state.result?.status,
      lensMode: state.result?.lensMode,
      camera: state.result?.camera,
      reports: state.result?.evaluation.actors.map((a) => a.report),
      tradeoff: state.result?.tradeoff,
      suggestion: state.result?.suggestion,
      beatIndex: state.beatIndex,
      beatCount: state.scenario.beats.length,
      beats: state.scenario.beats.map((b) => ({ label: b.label, duration: b.duration })),
      beatT: state.beatT,
      playing: state.playing,
      dirty: state.dirty,
      solveCount: state.solveCount,
      lastSolveAt: state.lastSolveAt,
      selectedId: state.selectedId,
      hash: location.hash,
    }),
    selectScenario: (id: string) => switchScenario(scenarioById(id), null),
    setAspect: (a: number) => {
      state.aspect = a;
      dom.aspectSelect.value = String(a);
      state.constraints = applyOverrides({ ...state.scenario.constraints, aspect: a }, state.overrides);
      state.previousParams = null;
      solveNow();
    },
    setMargin: (side: MarginSide, pct: number) => {
      state.overrides.margins[side] = pct / 100;
      dom.marginInputs[side].value = String(pct);
      updateRangeLabels();
      commitOverrides();
      solveNow();
    },
    moveActor: (id: string, x: number, y: number, z: number) => {
      const actor = state.actors.find((a) => a.id === id);
      if (!actor) return;
      actor.position = { x, y, z };
      state.previousParams = null;
      solveNow();
    },
    updateActor: (
      id: string,
      patch: Partial<Pick<Actor, 'height' | 'radius' | 'importance' | 'name'>>,
    ): boolean => {
      const actor = state.actors.find((a) => a.id === id);
      if (!actor) return false;
      if (patch.height !== undefined) actor.height = Math.max(0.6, patch.height);
      if (patch.radius !== undefined) actor.radius = Math.max(0.1, patch.radius);
      if (patch.importance !== undefined) {
        actor.importance = Math.max(1, Math.min(5, Math.round(patch.importance)));
      }
      if (patch.name !== undefined && patch.name.trim()) actor.name = patch.name.trim();
      state.previousParams = null;
      stage.setActors(state.actors);
      renderActorInspector();
      solveNow();
      return true;
    },
    setConstraint: (key: 'fovMaxDeg' | 'horizontalFovMaxDeg' | 'distanceMax' | 'workingFovDeg' | 'yawDeg', value: number) => {
      state.overrides[key] = value;
      dom[key === 'fovMaxDeg' ? 'fovMax' : key === 'horizontalFovMaxDeg' ? 'hFovMax' : key === 'distanceMax' ? 'distanceMax' : key === 'workingFovDeg' ? 'workingFov' : 'yaw'].value = String(value);
      updateRangeLabels();
      commitOverrides();
      solveNow();
    },
    playBeat: (index: number) => {
      state.playing = false;
      setBeat(index, 0, false);
      solveNow();
    },
    setPlaying: (on: boolean) => {
      state.playing = on;
      renderTransport();
    },
    /** Stop playback without reverting positions, so a captured pose stays put. */
    pause: () => {
      state.playing = false;
      renderTransport();
    },
    /**
     * Move several actors in one solve. Used by the release runner to stage
     * deployment scenarios (dispersed / clustered, mixed body sizes) and to
     * drive the in-scene multi-actor moves deterministically.
     */
    positionActors: (positions: Array<{ id: string; x: number; y: number; z: number }>): string[] => {
      const applied: string[] = [];
      for (const p of positions) {
        const actor = state.actors.find((a) => a.id === p.id);
        if (!actor) continue;
        actor.position = { x: p.x, y: p.y, z: p.z };
        applied.push(p.id);
      }
      state.playing = false;
      state.previousParams = null;
      stage.setActors(state.actors);
      solveNow();
      return applied;
    },
    tickOnce: (dt: number) => {
      // Advance playback by `dt` ms without waiting a frame; used by headless
      // checks to sample camera continuity mid-beat.
      if (!state.playing) return;
      const beat = state.scenario.beats[state.beatIndex];
      state.beatT = Math.min(1, state.beatT + dt / beat.duration);
      applyBeat(easeInOut(state.beatT));
      if (state.beatT >= 1 && state.beatIndex < state.scenario.beats.length - 1) {
        state.beatIndex += 1;
        state.beatT = 0;
        applyBeat(0);
      }
      solveNow();
    },
    solve: () => solveNow(),
  };
}

function beatStartPositions(scenario: Scenario, index: number): Record<string, [number, number, number]> {
  const out: Record<string, [number, number, number]> = {};
  for (const a of scenario.actors) out[a.id] = [a.position.x, a.position.y, a.position.z];
  for (let i = 0; i < index; i++) {
    for (const move of scenario.beats[i].moves) out[move.actorId] = move.to;
  }
  return out;
}

function cloneActors(base: Actor[], snapshot: ScenarioSnapshot | null): Actor[] {
  return base.map((a) => {
    const saved = snapshot?.actors.find((s) => s.id === a.id);
    return {
      ...a,
      position: saved ? { x: saved.x, y: saved.y, z: saved.z } : { ...a.position },
      height: saved?.height ?? a.height,
      radius: saved?.radius ?? a.radius,
      importance: saved?.importance ?? a.importance,
    };
  });
}

function cell(label: string, value: string, sub: string): string {
  return `<div class="cell"><span class="cell-label">${label}</span><span class="cell-value">${value}</span>${sub ? `<span class="cell-sub">${sub}</span>` : ''}</div>`;
}

function reasonLabel(code: string): string {
  const map: Record<string, string> = {
    'fov-cap': '垂直视场上限',
    'horizontal-cap': '水平视场上限',
    'distance-cap': '距离上限',
    'distance-floor': '距离下限',
    'camera-floor': '机位高度下限',
    'actor-behind': '角色在机位后方',
    margin: '安全边距',
  };
  return map[code] ?? code;
}

function sideLabel(side: string): string {
  return ({ left: '左', right: '右', top: '上', bottom: '下', behind: '后方' } as Record<string, string>)[side] ?? side;
}

function aspectLabel(a: number): string {
  const preset = ASPECT_PRESETS.find((p) => Math.abs(p.value - a) < 1e-4);
  return preset ? `${preset.label}` : a.toFixed(2);
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function flash(btn: HTMLButtonElement, text: string): void {
  const prev = btn.textContent;
  btn.textContent = text;
  setTimeout(() => (btn.textContent = prev), 1600);
}

function collect(root: HTMLElement): Dom {
  const q = <T extends Element>(sel: string): T => {
    const el = root.querySelector(sel) as T | null;
    if (!el) throw new Error(`missing ${sel}`);
    return el;
  };
  const marginInputs = {} as Dom['marginInputs'];
  const marginLabels = {} as Dom['marginLabels'];
  for (const side of ['left', 'right', 'top', 'bottom'] as MarginSide[]) {
    marginInputs[side] = q<HTMLInputElement>(`#margin-${side}`);
    marginLabels[side] = q<HTMLElement>(`#margin-${side}-label`);
  }
  return {
    canvas: q<HTMLCanvasElement>('#gl-canvas'),
    overlay: q<HTMLCanvasElement>('#diagnostic-overlay'),
    plan: q<HTMLCanvasElement>('#plan-canvas'),
    planWrap: q<HTMLElement>('#plan-wrap'),
    viewport: q<HTMLElement>('#viewport'),
    stageFrame: q<HTMLElement>('#stage-frame'),
    scenarioSelect: q<HTMLSelectElement>('#scenario-select'),
    scenarioSubtitle: q<HTMLElement>('#scenario-subtitle'),
    aspectSelect: q<HTMLSelectElement>('#aspect-select'),
    yaw: q<HTMLInputElement>('#yaw'),
    yawLabel: q<HTMLElement>('#yaw-label'),
    workingFov: q<HTMLInputElement>('#working-fov'),
    workingFovLabel: q<HTMLElement>('#working-fov-label'),
    fovMax: q<HTMLInputElement>('#fov-max'),
    fovMaxLabel: q<HTMLElement>('#fov-max-label'),
    hFovMax: q<HTMLInputElement>('#hfov-max'),
    hFovMaxLabel: q<HTMLElement>('#hfov-max-label'),
    distanceMax: q<HTMLInputElement>('#distance-max'),
    distanceMaxLabel: q<HTMLElement>('#distance-max-label'),
    marginInputs,
    marginLabels,
    playButton: q<HTMLButtonElement>('#play-button'),
    replayButton: q<HTMLButtonElement>('#replay-button'),
    resetButton: q<HTMLButtonElement>('#reset-button'),
    stepButtons: Array.from(root.querySelectorAll<HTMLButtonElement>('.step-button')),
    progressFill: q<HTMLElement>('#progress-fill'),
    beatLabel: q<HTMLElement>('#beat-label'),
    beatNotes: q<HTMLElement>('#beat-notes'),
    statusLine: q<HTMLElement>('#status-line'),
    targetBounds: q<HTMLElement>('#target-bounds'),
    reframeButton: q<HTMLButtonElement>('#reframe-button'),
    resultGrid: q<HTMLElement>('#result-grid'),
    tradeoffCard: q<HTMLElement>('#tradeoff-card'),
    tradeoffBody: q<HTMLElement>('#tradeoff-body'),
    tradeoffTags: q<HTMLElement>('#tradeoff-tags'),
    suggestionCard: q<HTMLElement>('#suggestion-card'),
    suggestionBody: q<HTMLElement>('#suggestion-body'),
    applySuggestion: q<HTMLButtonElement>('#apply-suggestion'),
    actorRows: q<HTMLElement>('#actor-rows'),
    actorCount: q<HTMLElement>('#actor-count'),
    inspector: q<HTMLElement>('#inspector'),
    inspectorName: q<HTMLElement>('#inspector-name'),
    inspectorColor: q<HTMLElement>('#inspector-color'),
    actorName: q<HTMLInputElement>('#actor-name'),
    actorX: q<HTMLInputElement>('#actor-x'),
    actorY: q<HTMLInputElement>('#actor-y'),
    actorZ: q<HTMLInputElement>('#actor-z'),
    actorHeight: q<HTMLInputElement>('#actor-height'),
    actorImportance: q<HTMLInputElement>('#actor-importance'),
    actorRadius: q<HTMLInputElement>('#actor-radius'),
    togglePlan: q<HTMLButtonElement>('#toggle-plan'),
    copyLink: q<HTMLButtonElement>('#copy-link'),
    pipeline: q<HTMLElement>('#pipeline'),
  };
}

function template(): string {
  return `
  <div class="app-shell">
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark">▣</span>
        <div>
          <h1>共同取景摄像机</h1>
          <p>按角色三维包围与重要性求解机位、朝向与受限视场</p>
        </div>
      </div>
      <div class="topbar-meta">
        <label class="select-label">场景<select id="scenario-select"></select></label>
        <label class="select-label">画幅<select id="aspect-select"></select></label>
        <span id="pipeline" class="pipeline"></span>
      </div>
    </header>

    <div class="workspace">
      <section class="stage-column">
        <div id="viewport" class="viewport">
          <div id="stage-frame" class="stage-frame">
            <canvas id="gl-canvas"></canvas>
            <canvas id="diagnostic-overlay" class="diagnostic-overlay"></canvas>
            <div id="actor-labels" class="actor-labels" aria-hidden="true"></div>
            <div class="viewport-badges">
              <span class="badge badge-live">共同取景输出</span>
              <span class="badge">包围框 = 真实身体投影</span>
            </div>
            <div class="viewport-legend">
              <span><i class="legend-line safe"></i>安全区</span>
              <span><i class="legend-line act"></i>角色包围</span>
              <span><i class="legend-line bad"></i>越界</span>
            </div>
          </div>
        </div>

        <div class="transport">
          <div class="transport-left">
            <button id="play-button" class="btn btn-primary" aria-pressed="false">播放</button>
            <button id="replay-button" class="btn">重放</button>
            <button id="reset-button" class="btn btn-quiet">还原场景</button>
            <span id="beat-label" class="beat-label"></span>
          </div>
          <div class="progress"><div id="progress-fill" class="progress-fill"></div></div>
          <div class="steps">
            <button class="step-button is-active">1</button>
            <button class="step-button">2</button>
            <button class="step-button">3</button>
            <button class="step-button">4</button>
          </div>
        </div>

        <div id="plan-wrap" class="plan-wrap">
          <div class="plan-head">
            <h4>俯视平面 · 共同构图分布</h4>
            <button id="toggle-plan" class="btn btn-quiet btn-small">隐藏平面示意</button>
          </div>
          <canvas id="plan-canvas" class="plan-canvas"></canvas>
        </div>
      </section>

      <aside class="panel-column">
        <section class="panel">
          <div class="panel-head">
            <h2>约束</h2>
            <span class="panel-sub">由共同取景内核驱动</span>
          </div>
          <p id="scenario-subtitle" class="scenario-subtitle"></p>

          <div class="control">
            <div class="control-row"><label for="yaw">偏航</label><span id="yaw-label" class="control-value">0°</span></div>
            <input id="yaw" type="range" min="-60" max="60" step="0.5" value="0" />
          </div>
          <div class="control">
            <div class="control-row"><label for="working-fov">工作镜头（垂直视场）</label><span id="working-fov-label" class="control-value">38°</span></div>
            <input id="working-fov" type="range" min="8" max="90" step="1" value="38" />
          </div>
          <div class="control pair">
            <div>
              <div class="control-row"><label for="fov-max">垂直上限</label><span id="fov-max-label" class="control-value">52°</span></div>
              <input id="fov-max" type="range" min="12" max="120" step="1" value="52" />
            </div>
            <div>
              <div class="control-row"><label for="hfov-max">水平上限</label><span id="hfov-max-label" class="control-value">92°</span></div>
              <input id="hfov-max" type="range" min="20" max="150" step="1" value="92" />
            </div>
          </div>
          <div class="control">
            <div class="control-row"><label for="distance-max">距离上限</label><span id="distance-max-label" class="control-value">42 m</span></div>
            <input id="distance-max" type="range" min="4" max="120" step="1" value="42" />
          </div>

          <div class="margins">
            <div class="margins-head"><h3>安全边距</h3><span class="panel-sub">四向真实参与求解</span></div>
            <div class="margin-controls">
              ${(['left', 'right', 'top', 'bottom'] as MarginSide[])
                .map(
                  (side) => `<div class="control">
                    <div class="control-row"><label for="margin-${side}">${sideLabel(side)}</label><span id="margin-${side}-label" class="control-value">7%</span></div>
                    <input id="margin-${side}" type="range" min="0" max="30" step="1" value="7" />
                  </div>`,
                )
                .join('')}
            </div>
          </div>

          <div class="beats">
            <div class="beats-head"><h3>演示节拍</h3><span class="panel-sub">可回放控制</span></div>
            <ol id="beat-notes" class="beat-notes"></ol>
          </div>
        </section>

        <section class="panel panel-results">
          <div class="panel-head">
            <h2>结果</h2>
            <button id="copy-link" class="btn btn-quiet btn-small">复制可重放链接</button>
          </div>
          <div id="status-line" class="status-line"></div>
          <div id="target-bounds" class="target-bounds" data-testid="target-bounds"></div>
          <div class="reframe-row">
            <button id="reframe-button" class="btn btn-primary btn-small">重新共同取景</button>
            <span class="muted reframe-hint">对当前角色与约束重新执行同一求解内核</span>
          </div>
          <div id="result-grid" class="result-grid"></div>

          <div id="tradeoff-card" class="card card-warn" hidden>
            <h3>取舍说明</h3>
            <div id="tradeoff-tags" class="tags"></div>
            <p id="tradeoff-body" class="card-body"></p>
          </div>

          <div id="suggestion-card" class="card card-neutral" hidden>
            <h3>可行方向（仅为建议，不自动扩张）</h3>
            <div id="suggestion-body" class="card-body"></div>
            <button id="apply-suggestion" class="btn btn-small">采用建议上限重新求解</button>
          </div>

          <div class="actor-list">
            <div class="actor-list-head">
              <h3>每个角色的投影</h3>
              <span id="actor-count" class="panel-sub"></span>
            </div>
            <div id="actor-rows" class="actor-rows"></div>
          </div>

          <div id="inspector" class="inspector" hidden>
            <div class="inspector-head">
              <span id="inspector-color" class="swatch"></span>
              <h3 id="inspector-name">角色</h3>
            </div>
            <div class="inspector-grid">
              <label>名称 <input id="actor-name" type="text" /></label>
              <label>X <input id="actor-x" type="number" step="0.05" /></label>
              <label>Y（脚底） <input id="actor-y" type="number" step="0.05" /></label>
              <label>Z <input id="actor-z" type="number" step="0.05" /></label>
              <label>身高 <input id="actor-height" type="number" step="0.05" min="0.6" /></label>
              <label>半径 <input id="actor-radius" type="number" step="0.02" min="0.1" /></label>
              <label>重要性 <input id="actor-importance" type="number" step="1" min="1" max="5" /></label>
            </div>
          </div>
        </section>
      </aside>
    </div>

    <footer class="hintbar">
      拖动画面中的角色可改变位置，点击角色行可精确编辑。画面上的包围框由内核投影的真实身体采样生成，不是 HUD 箭头。
    </footer>
  </div>`;
}
