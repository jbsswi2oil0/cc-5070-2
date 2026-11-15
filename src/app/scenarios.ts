import type { Actor, FramingConstraints, Margins } from '../framing/types';

export interface DemoBeat {
  label: string;
  duration: number;
  moves: Array<{ actorId: string; to: [number, number, number] }>;
}

export interface Scenario {
  id: string;
  name: string;
  subtitle: string;
  actors: Actor[];
  constraints: Omit<FramingConstraints, 'aspect'>;
  beats: DemoBeat[];
}

const margins = (left: number, right: number, top: number, bottom: number): Margins => ({
  left,
  right,
  top,
  bottom,
});

const actor = (
  id: string,
  name: string,
  x: number,
  y: number,
  z: number,
  height: number,
  importance: number,
  color: string,
  radius = 0.34,
): Actor => ({ id, name, position: { x, y, z }, height, radius, importance, color });

export const scenarios: Scenario[] = [
  {
    id: 'plaza',
    name: '高低平台',
    subtitle: '两名角色分站 0.55 m 与 1.15 m 台上，第三人位于前景地面。检验高差、俯仰与机位高度下限。',
    actors: [
      actor('lin', '林', -3.1, 0.55, 1.4, 1.72, 4, '#f08a4b'),
      actor('qiao', '乔', 2.9, 1.15, 2.6, 2.02, 5, '#5ec8e5'),
      actor('rui', '睿', 0.5, 0, -2.4, 1.64, 2, '#d6bf6a'),
    ],
    constraints: {
      yawDeg: 2,
      fovMaxDeg: 52,
      fovMinDeg: 6,
      horizontalFovMaxDeg: 92,
      workingFovDeg: 38,
      distanceMin: 1.6,
      distanceMax: 42,
      margins: margins(0.07, 0.07, 0.07, 0.07),
      minCameraHeight: 0.3,
    },
    beats: [
      { label: '初始三人', duration: 900, moves: [] },
      {
        label: '乔横向移开',
        duration: 1600,
        moves: [{ actorId: 'qiao', to: [6.4, 1.15, 3.2] }],
      },
      {
        label: '睿逼近前景',
        duration: 1600,
        moves: [
          { actorId: 'qiao', to: [5.2, 1.15, 2.0] },
          { actorId: 'rui', to: [1.6, 0, -5.4] },
        ],
      },
      {
        label: '乔下到地面',
        duration: 1600,
        moves: [
          { actorId: 'qiao', to: [3.4, 0, 1.2] },
          { actorId: 'rui', to: [0.4, 0, -3.0] },
        ],
      },
    ],
  },
  {
    id: 'stagger',
    name: '前后纵深错位',
    subtitle: '近景占屏大、远景占屏小，深度差与时序移动会改变投影包围，不能只平均位置。',
    actors: [
      actor('near', '近景', -1.7, 0, -4.4, 1.78, 4, '#6fcb8f'),
      actor('mid', '中景', 0.9, 0, 1.2, 1.7, 3, '#b48be0'),
      actor('far', '远景', -0.5, 0, 7.6, 1.86, 5, '#e2648c'),
    ],
    constraints: {
      yawDeg: -3,
      fovMaxDeg: 50,
      fovMinDeg: 6,
      horizontalFovMaxDeg: 90,
      workingFovDeg: 40,
      distanceMin: 1.5,
      distanceMax: 45,
      margins: margins(0.08, 0.08, 0.08, 0.08),
      minCameraHeight: 0.28,
    },
    beats: [
      { label: '初始纵深', duration: 900, moves: [] },
      { label: '远景前移', duration: 1600, moves: [{ actorId: 'far', to: [-0.5, 0, 3.0] }] },
      {
        label: '近景横移',
        duration: 1600,
        moves: [
          { actorId: 'near', to: [3.4, 0, -3.4] },
          { actorId: 'far', to: [-1.2, 0, 4.4] },
        ],
      },
      {
        label: '拉开纵深',
        duration: 1600,
        moves: [
          { actorId: 'near', to: [-2.6, 0, -6.0] },
          { actorId: 'far', to: [1.0, 0, 8.5] },
        ],
      },
    ],
  },
  {
    id: 'wide-spread',
    name: '横向分散 · 受限镜头',
    subtitle: '视场与距离上限收紧，三人横向分散到无法同时满足。镜头不越界扩张，报告取舍。',
    actors: [
      actor('west', '西', -13, 0, -3.5, 1.75, 5, '#f08a4b'),
      actor('east', '东', 13.5, 0.6, 3.0, 1.9, 3, '#5ec8e5'),
      actor('north', '北', 0.5, 0, 9.5, 1.68, 2, '#d6bf6a'),
    ],
    constraints: {
      yawDeg: 0,
      fovMaxDeg: 34,
      fovMinDeg: 6,
      horizontalFovMaxDeg: 52,
      workingFovDeg: 30,
      distanceMin: 2,
      distanceMax: 15,
      margins: margins(0.08, 0.08, 0.08, 0.08),
      minCameraHeight: 0.3,
    },
    beats: [
      { label: '受限初始', duration: 900, moves: [] },
      { label: '西侧更远', duration: 1600, moves: [{ actorId: 'west', to: [-18, 0, -4.5] }] },
      {
        label: '东侧抬高',
        duration: 1600,
        moves: [{ actorId: 'east', to: [15, 2.0, 3.6] }],
      },
      { label: '收回中间', duration: 1600, moves: [{ actorId: 'west', to: [-9, 0, -2.0] }, { actorId: 'east', to: [10, 0.6, 2.0] }] },
    ],
  },
  {
    id: 'two-shot',
    name: '双人对白 · 竖屏',
    subtitle: '竖屏下水平比垂直更先触顶：并排双人需要更多距离，而不是更大垂直视场。',
    actors: [
      actor('left', '左侧', -1.45, 0, 0.7, 1.76, 4, '#e2648c'),
      actor('right', '右侧', 1.55, 0, 0.15, 1.79, 4, '#5ec8e5'),
    ],
    constraints: {
      yawDeg: 0,
      fovMaxDeg: 56,
      fovMinDeg: 6,
      horizontalFovMaxDeg: 80,
      workingFovDeg: 36,
      distanceMin: 1.2,
      distanceMax: 30,
      margins: margins(0.06, 0.06, 0.06, 0.06),
      minCameraHeight: 0.25,
    },
    beats: [
      { label: '初始双人', duration: 900, moves: [] },
      { label: '拉开间距', duration: 1600, moves: [{ actorId: 'left', to: [-2.4, 0, 1.2] }, { actorId: 'right', to: [2.5, 0, 0.4] }] },
      { label: '一高一低', duration: 1600, moves: [{ actorId: 'left', to: [-1.9, 0.8, 1.0] }, { actorId: 'right', to: [2.1, 0, 0.2] }] },
      { label: '贴近对白', duration: 1600, moves: [{ actorId: 'left', to: [-1.0, 0.8, 0.9] }, { actorId: 'right', to: [1.1, 0, 0.3] }] },
    ],
  },
  {
    id: 'deployment',
    name: '部署验收 · 分散与聚合',
    subtitle:
      '四名体型不同的角色（高个、宽体、瘦高、矮个）先聚合、再横向与纵深分散、最后重新聚拢。用于发布部署检查：同一套受限镜头在分散时需要取舍，聚合时恢复完整入画。',
    actors: [
      actor('tall', '高个', -1.6, 0.35, 0.3, 2.04, 5, '#5ec8e5', 0.4),
      actor('short', '矮个', -0.5, 0, 0.7, 1.42, 2, '#f08a4b', 0.26),
      actor('broad', '宽体', 0.7, 0, 0.2, 1.74, 3, '#d6bf6a', 0.46),
      actor('slim', '瘦高', 1.9, 0, 0.6, 1.88, 4, '#b48be0', 0.22),
    ],
    constraints: {
      yawDeg: 0,
      fovMaxDeg: 44,
      fovMinDeg: 6,
      horizontalFovMaxDeg: 74,
      workingFovDeg: 38,
      distanceMin: 1.6,
      distanceMax: 16,
      margins: margins(0.08, 0.08, 0.08, 0.08),
      minCameraHeight: 0.3,
    },
    beats: [
      { label: '四人聚合', duration: 900, moves: [] },
      {
        label: '横向与纵深分散',
        duration: 2000,
        moves: [
          { actorId: 'tall', to: [-10.5, 1.1, 3.0] },
          { actorId: 'short', to: [9.0, 0, -3.4] },
          { actorId: 'broad', to: [1.2, 0, 8.2] },
          { actorId: 'slim', to: [-2.4, 0, -7.6] },
        ],
      },
      {
        label: '重新聚合',
        duration: 2000,
        moves: [
          { actorId: 'tall', to: [-1.6, 0.35, 0.3] },
          { actorId: 'short', to: [-0.5, 0, 0.7] },
          { actorId: 'broad', to: [0.7, 0, 0.2] },
          { actorId: 'slim', to: [1.9, 0, 0.6] },
        ],
      },
    ],
  },
];

export function scenarioById(id: string): Scenario {
  return scenarios.find((s) => s.id === id) ?? scenarios[0];
}

export const ASPECT_PRESETS: Array<{ label: string; value: number; hint: string }> = [
  { label: '16:9', value: 16 / 9, hint: '宽屏' },
  { label: '9:16', value: 9 / 16, hint: '竖屏' },
  { label: '21:9', value: 21 / 9, hint: '超宽' },
  { label: '4:3', value: 4 / 3, hint: '经典' },
];
