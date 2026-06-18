export type SeatedMotionLanguageVersion = 'seated-v1';

export type AvatarReactionFamily =
  | 'defensive'
  | 'withdrawn'
  | 'anxious'
  | 'ashamed'
  | 'reflective'
  | 'risk'
  | 'soft_engagement';

export type SeatedMotionPoseOffsets = Partial<Record<
  | 'hipX'
  | 'hipY'
  | 'hipZ'
  | 'spineX'
  | 'spineY'
  | 'chestX'
  | 'chestY'
  | 'chestZ'
  | 'neckX'
  | 'neckY'
  | 'headX'
  | 'headY'
  | 'headZ'
  | 'armX'
  | 'forearmX'
  | 'leftArmY'
  | 'rightArmY'
  | 'leftArmZ'
  | 'rightArmZ',
  number
>>;

export type SeatedMotionArmOffsets = Partial<Record<
  | 'upperArmX'
  | 'leftUpperArmY'
  | 'rightUpperArmY'
  | 'leftUpperArmZ'
  | 'rightUpperArmZ'
  | 'leftLowerArmX'
  | 'rightLowerArmX'
  | 'leftLowerArmY'
  | 'rightLowerArmY'
  | 'leftLowerArmZ'
  | 'rightLowerArmZ'
  | 'handX'
  | 'leftHandY'
  | 'rightHandY'
  | 'leftHandZ'
  | 'rightHandZ',
  number
>>;

export type SeatedMotionSample = {
  pose: SeatedMotionPoseOffsets;
  armPose: SeatedMotionArmOffsets;
  gaze?: 'camera_soft' | 'avoid_left' | 'avoid_right' | 'look_down' | 'scanning' | 'guarded';
};

export type SeatedMotionKeyframe = {
  timeMs: number;
  poseName: string;
  sample: SeatedMotionSample;
};

export type SeatedMotionProgram = {
  language: SeatedMotionLanguageVersion;
  id: string;
  main: string;
  durationMs: number;
  keyframes: SeatedMotionKeyframe[];
  source: string;
};

export type SeatedMotionIssue = {
  severity: 'error' | 'warning';
  message: string;
  line?: number;
};

export type SeatedMotionCompileResult =
  | { ok: true; program: SeatedMotionProgram; issues: SeatedMotionIssue[] }
  | { ok: false; issues: SeatedMotionIssue[] };

type PoseDefinition = {
  name: string;
  body: string;
  line: number;
};

type AnimationDefinition = {
  name: string;
  body: string;
  line: number;
};

type TemplateOptions = {
  seed?: string;
  intensity?: number;
};

const FORBIDDEN_TARGETS = new Set([
  'root',
  'base',
  'center',
  'hips',
  'hip',
  'legs',
  'leg',
  'upperleg',
  'lowerleg',
  'feet',
  'foot',
  'toes',
  'toe',
  'leftleg',
  'rightleg',
  'leftfoot',
  'rightfoot',
]);

const ALLOWED_TARGETS = new Set([
  'spine',
  'chest',
  'neck',
  'head',
  'shoulders',
  'shoulder',
  'leftshoulder',
  'rightshoulder',
  'upperarms',
  'upperarm',
  'leftupperarm',
  'rightupperarm',
  'lowerarms',
  'lowerarm',
  'leftlowerarm',
  'rightlowerarm',
  'hands',
  'hand',
  'lefthand',
  'righthand',
  'gaze',
]);

export function compileSeatedMotionScript(
  source: string,
  options: { id?: string; language?: SeatedMotionLanguageVersion } = {},
): SeatedMotionCompileResult {
  const issues: SeatedMotionIssue[] = [];
  const normalized = stripComments(source);
  const poseDefinitions = parseBlockDefinitions(normalized, '@pose');
  const animationDefinitions = parseBlockDefinitions(normalized, '@animation');
  const mainMatch = normalized.match(/\bmain\s+([A-Za-z_][\w-]*)\s*;/);

  if (!mainMatch) {
    return { ok: false, issues: [{ severity: 'error', message: 'Missing `main <animation>;` declaration.' }] };
  }
  if (poseDefinitions.length === 0) {
    return { ok: false, issues: [{ severity: 'error', message: 'Motion script must define at least one @pose block.' }] };
  }
  if (animationDefinitions.length === 0) {
    return { ok: false, issues: [{ severity: 'error', message: 'Motion script must define at least one @animation block.' }] };
  }

  const poses = new Map<string, SeatedMotionSample>([['baseline', emptySample()]]);
  poseDefinitions.forEach((definition) => {
    if (poses.has(definition.name)) {
      issues.push({
        severity: 'error',
        line: definition.line,
        message: `Duplicate pose definition: ${definition.name}.`,
      });
      return;
    }
    const pose = parsePoseDefinition(definition);
    issues.push(...pose.issues);
    if (pose.sample) poses.set(definition.name, pose.sample);
  });

  const animations = new Map<string, SeatedMotionKeyframe[]>();
  animationDefinitions.forEach((definition) => {
    if (animations.has(definition.name)) {
      issues.push({
        severity: 'error',
        line: definition.line,
        message: `Duplicate animation definition: ${definition.name}.`,
      });
      return;
    }
    const animation = parseAnimationDefinition(definition, poses);
    issues.push(...animation.issues);
    if (animation.keyframes) animations.set(definition.name, animation.keyframes);
  });

  const main = mainMatch[1];
  const keyframes = animations.get(main);
  if (!keyframes) {
    issues.push({ severity: 'error', message: `Main animation not found: ${main}.` });
  }
  if (issues.some((issue) => issue.severity === 'error') || !keyframes) {
    return { ok: false, issues };
  }

  const sortedKeyframes = [...keyframes].sort((a, b) => a.timeMs - b.timeMs);
  const durationMs = sortedKeyframes.length ? sortedKeyframes[sortedKeyframes.length - 1].timeMs : 0;
  if (durationMs < 250) {
    issues.push({ severity: 'warning', message: 'Motion duration is very short; playback may look abrupt.' });
  }

  return {
    ok: true,
    program: {
      language: options.language ?? 'seated-v1',
      id: options.id ?? main,
      main,
      durationMs,
      keyframes: sortedKeyframes,
      source,
    },
    issues,
  };
}

export function sampleSeatedMotionProgram(
  program: SeatedMotionProgram,
  localTimeSeconds: number,
  scale = 1,
): SeatedMotionSample {
  const frames = program.keyframes;
  if (!frames.length) return emptySample();
  const timeMs = Math.max(0, localTimeSeconds * 1000);
  if (timeMs <= frames[0].timeMs) return scaleSample(frames[0].sample, scale);
  const last = frames[frames.length - 1];
  if (timeMs >= last.timeMs) return scaleSample(last.sample, scale);

  const nextIndex = frames.findIndex((frame) => frame.timeMs >= timeMs);
  const from = frames[Math.max(0, nextIndex - 1)];
  const to = frames[nextIndex];
  const span = Math.max(1, to.timeMs - from.timeMs);
  const progress = smoothstep((timeMs - from.timeMs) / span);
  return scaleSample(blendSamples(from.sample, to.sample, progress), scale);
}

export function seatedMotionScriptTemplate(
  family: AvatarReactionFamily,
  options: TemplateOptions = {},
): { id: string; script: string; variant: string } {
  const variantIndex = hashSeed(`${family}:${options.seed ?? ''}`) % 3;
  const side = variantIndex === 1 ? 'right' : 'left';
  const otherSide = side === 'left' ? 'right' : 'left';
  const suffix = ['a', 'b', 'c'][variantIndex] ?? 'a';
  const intensity = clampAmount(options.intensity ?? 1);
  const a = (value: number) => roundAmount(value * intensity);

  if (family === 'defensive') {
    const turn = side;
    if (variantIndex === 1) {
      return {
        id: `sml_defensive_avoid_${suffix}`,
        variant: suffix,
        script: `
@pose guarded_avoid {
  chest bend forward ${a(0.04)};
  neck bend forward ${a(0.08)};
  head turn ${turn} ${a(0.20)};
  gaze avoid_${turn} ${a(0.52)};
  hands press_lap ${a(0.34)};
}
@pose held_avoid {
  head turn ${turn} ${a(0.14)};
  gaze avoid_${turn} ${a(0.38)};
  hands press_lap ${a(0.24)};
}
@animation defensive_avoid {
  0.00: baseline;
  0.34: guarded_avoid;
  1.20: held_avoid;
  2.35: baseline;
}
main defensive_avoid;
`.trim(),
      };
    }
    if (variantIndex === 2) {
      return {
        id: `sml_defensive_side_guard_${suffix}`,
        variant: suffix,
        script: `
@pose side_guard {
  spine bend backward ${a(0.06)};
  chest turn ${turn} ${a(0.14)};
  head turn ${turn} ${a(0.24)};
  gaze guarded ${a(0.42)};
  hands press_lap ${a(0.30)};
}
@pose settle_guard {
  chest turn ${turn} ${a(0.08)};
  head turn ${turn} ${a(0.16)};
  gaze guarded ${a(0.28)};
  hands press_lap ${a(0.20)};
}
@animation defensive_side_guard {
  0.00: baseline;
  0.28: side_guard;
  1.08: settle_guard;
  2.25: baseline;
}
main defensive_side_guard;
`.trim(),
      };
    }
    return {
      id: `sml_defensive_guard_${suffix}`,
      variant: suffix,
      script: `
@pose recoil {
  spine bend backward ${a(0.08)};
  chest bend backward ${a(0.16)};
  head turn ${turn} ${a(0.22)};
  gaze avoid_${turn} ${a(0.46)};
  hands press_lap ${a(0.32)};
}
@pose guarded_hold {
  chest bend backward ${a(0.08)};
  head turn ${turn} ${a(0.12)};
  gaze guarded ${a(0.26)};
  hands press_lap ${a(0.22)};
}
@animation defensive_guard {
  0.00: baseline;
  0.24: recoil;
  1.18: guarded_hold;
  2.25: baseline;
}
main defensive_guard;
`.trim(),
    };
  }

  if (family === 'anxious') {
    return {
      id: `sml_anxious_fidget_${suffix}`,
      variant: suffix,
      script: `
@pose fidget_${side} {
  chest bend forward ${a(0.08)};
  head bend forward ${a(0.10)};
  gaze scanning ${a(0.34)};
  hands rub_${side} ${a(0.26)};
}
@pose fidget_${otherSide} {
  chest turn ${otherSide} ${a(0.05)};
  neck turn ${side} ${a(0.08)};
  gaze avoid_${otherSide} ${a(0.28)};
  hands rub_${otherSide} ${a(0.22)};
}
@animation anxious_fidget {
  0.00: baseline;
  0.32: fidget_${side};
  0.78: fidget_${otherSide};
  1.22: fidget_${side};
  2.20: baseline;
}
main anxious_fidget;
`.trim(),
    };
  }

  if (family === 'ashamed') {
    return {
      id: `sml_ashamed_drop_${suffix}`,
      variant: suffix,
      script: `
@pose drop_gaze {
  spine bend forward ${a(0.10)};
  chest bend forward ${a(0.14)};
  neck bend forward ${a(0.28)};
  head bend forward ${a(0.38)};
  gaze look_down ${a(0.74)};
  hands press_lap ${a(0.32)};
}
@pose held_low {
  chest bend forward ${a(0.10)};
  head bend forward ${a(0.28)};
  gaze look_down ${a(0.62)};
  hands press_lap ${a(0.26)};
}
@animation ashamed_drop {
  0.00: baseline;
  0.48: drop_gaze;
  1.80: held_low;
  3.00: baseline;
}
main ashamed_drop;
`.trim(),
    };
  }

  if (family === 'withdrawn') {
    return {
      id: `sml_withdrawn_short_${suffix}`,
      variant: suffix,
      script: `
@pose short_answer {
  chest bend forward ${a(0.08)};
  neck bend forward ${a(0.20)};
  head turn ${side} ${a(0.16)};
  head bend forward ${a(0.24)};
  gaze avoid_${side} ${a(0.48)};
  hands press_lap ${a(0.18)};
}
@animation withdrawn_short {
  0.00: baseline;
  0.40: short_answer;
  1.60: short_answer;
  2.45: baseline;
}
main withdrawn_short;
`.trim(),
    };
  }

  if (family === 'reflective') {
    return {
      id: `sml_reflective_nod_${suffix}`,
      variant: suffix,
      script: `
@pose nod_down {
  chest bend forward ${a(0.06)};
  neck bend forward ${a(0.12)};
  head bend forward ${a(0.22)};
  gaze camera_soft ${a(0.18)};
}
@pose nod_up {
  chest bend forward ${a(0.04)};
  neck bend backward ${a(0.04)};
  head bend backward ${a(0.10)};
  gaze camera_soft ${a(0.16)};
}
@animation reflective_nod {
  0.00: baseline;
  0.42: nod_down;
  0.82: nod_up;
  1.26: nod_down;
  2.25: baseline;
}
main reflective_nod;
`.trim(),
    };
  }

  if (family === 'risk') {
    return {
      id: `sml_risk_low_${suffix}`,
      variant: suffix,
      script: `
@pose low_guarded {
  spine bend forward ${a(0.07)};
  chest bend forward ${a(0.10)};
  neck bend forward ${a(0.22)};
  head bend forward ${a(0.30)};
  gaze look_down ${a(0.62)};
  hands press_lap ${a(0.24)};
}
@animation risk_low {
  0.00: baseline;
  0.70: low_guarded;
  2.45: low_guarded;
  3.50: baseline;
}
main risk_low;
`.trim(),
    };
  }

  return {
    id: `sml_soft_engagement_${suffix}`,
    variant: suffix,
    script: `
@pose soft_forward {
  spine bend forward ${a(0.05)};
  chest bend forward ${a(0.08)};
  head bend forward ${a(0.08)};
  gaze camera_soft ${a(0.20)};
}
@pose soft_nod {
  chest bend forward ${a(0.06)};
  neck bend forward ${a(0.08)};
  head bend forward ${a(0.18)};
  gaze camera_soft ${a(0.18)};
}
@animation soft_engagement {
  0.00: baseline;
  0.46: soft_forward;
  0.96: soft_nod;
  2.20: baseline;
}
main soft_engagement;
`.trim(),
  };
}

function stripComments(source: string) {
  return source
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').replace(/#.*$/, ''))
    .join('\n');
}

function parseBlockDefinitions(source: string, keyword: '@pose' | '@animation') {
  const definitions: Array<PoseDefinition | AnimationDefinition> = [];
  const pattern = new RegExp(`${keyword}\\s+([A-Za-z_][\\w-]*)\\s*\\{([\\s\\S]*?)\\}`, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) {
    definitions.push({
      name: match[1],
      body: match[2],
      line: lineNumberAt(source, match.index),
    });
  }
  return definitions;
}

function parsePoseDefinition(definition: PoseDefinition): {
  sample?: SeatedMotionSample;
  issues: SeatedMotionIssue[];
} {
  const issues: SeatedMotionIssue[] = [];
  const sample = emptySample();
  const statements = definition.body
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);

  statements.forEach((statement) => {
    const parsed = parsePoseStatement(statement, definition.line);
    issues.push(...parsed.issues);
    if (parsed.sample) mergeSampleInPlace(sample, parsed.sample);
  });

  return { sample, issues };
}

function parsePoseStatement(statement: string, baseLine: number) {
  const tokens = statement.split(/\s+/).filter(Boolean);
  const issues: SeatedMotionIssue[] = [];
  if (tokens.length < 3) {
    return {
      issues: [{ severity: 'error' as const, line: baseLine, message: `Invalid pose statement: ${statement}.` }],
    };
  }

  const target = normalizeToken(tokens[0]);
  const action = normalizeToken(tokens[1]);
  const amountToken = tokens[tokens.length - 1];
  const amount = Number(amountToken);
  const direction = tokens.length >= 4 ? normalizeToken(tokens.slice(2, -1).join('_')) : undefined;

  if (FORBIDDEN_TARGETS.has(target)) {
    issues.push({
      severity: 'error',
      line: baseLine,
      message: `Forbidden lower-body or root target: ${tokens[0]}.`,
    });
  } else if (!ALLOWED_TARGETS.has(target)) {
    issues.push({
      severity: 'error',
      line: baseLine,
      message: `Unknown seated motion target: ${tokens[0]}.`,
    });
  }
  if (!Number.isFinite(amount) || amount < -1 || amount > 1) {
    issues.push({
      severity: 'error',
      line: baseLine,
      message: `Amount must be a normalized value between -1 and 1: ${amountToken}.`,
    });
  }
  if (issues.length) return { issues };

  const sample = statementToSample(target, action, direction, amount);
  if (!sample) {
    return {
      issues: [{
        severity: 'error' as const,
        line: baseLine,
        message: `Unsupported action for ${tokens[0]}: ${tokens.slice(1, -1).join(' ')}.`,
      }],
    };
  }
  return { sample, issues };
}

function parseAnimationDefinition(
  definition: AnimationDefinition,
  poses: Map<string, SeatedMotionSample>,
): {
  keyframes?: SeatedMotionKeyframe[];
  issues: SeatedMotionIssue[];
} {
  const issues: SeatedMotionIssue[] = [];
  const frames: SeatedMotionKeyframe[] = [];
  const statements = definition.body
    .split(';')
    .map((statement) => statement.trim())
    .filter(Boolean);

  statements.forEach((statement) => {
    const match = statement.match(/^([+-]?\d+(?:\.\d+)?)\s*:\s*([A-Za-z_][\w-]*)$/);
    if (!match) {
      issues.push({
        severity: 'error',
        line: definition.line,
        message: `Invalid animation keyframe: ${statement}.`,
      });
      return;
    }
    const seconds = Number(match[1]);
    const poseName = match[2];
    const sample = poses.get(poseName);
    if (!Number.isFinite(seconds) || seconds < 0) {
      issues.push({
        severity: 'error',
        line: definition.line,
        message: `Animation keyframe time must be non-negative: ${match[1]}.`,
      });
      return;
    }
    if (!sample) {
      issues.push({
        severity: 'error',
        line: definition.line,
        message: `Animation references unknown pose: ${poseName}.`,
      });
      return;
    }
    frames.push({
      timeMs: Math.round(seconds * 1000),
      poseName,
      sample,
    });
  });

  if (frames.length < 2) {
    issues.push({
      severity: 'error',
      line: definition.line,
      message: `Animation ${definition.name} needs at least two keyframes.`,
    });
  }
  return { keyframes: frames, issues };
}

function statementToSample(
  target: string,
  action: string,
  direction: string | undefined,
  amount: number,
): SeatedMotionSample | undefined {
  if (target === 'gaze') {
    if (['avoid_left', 'avoid_right', 'look_down', 'camera_soft', 'scanning', 'guarded'].includes(action)) {
      return { pose: {}, armPose: {}, gaze: action as SeatedMotionSample['gaze'] };
    }
    return undefined;
  }

  if (action === 'bend') return bodyBend(target, direction, amount);
  if (action === 'turn') return bodyTurn(target, direction, amount);
  if (action === 'sway') return bodySway(target, direction, amount);
  if (action === 'press_lap' && isHandTarget(target)) return pressLap(amount);
  if (action === 'rub_left' && isHandTarget(target)) return handRub('left', amount);
  if (action === 'rub_right' && isHandTarget(target)) return handRub('right', amount);
  if (action === 'lift' && isArmTarget(target)) return armLift(target, direction, amount);
  if (action === 'reach' && isArmTarget(target)) return armReach(target, direction, amount);
  return undefined;
}

function bodyBend(target: string, direction: string | undefined, amount: number): SeatedMotionSample | undefined {
  if (direction !== 'forward' && direction !== 'backward') return undefined;
  const sign = direction === 'forward' ? 1 : -1;
  const value = sign * amount;
  const pose: SeatedMotionPoseOffsets = {};
  if (target === 'spine') pose.spineX = value * 0.2;
  else if (target === 'chest') pose.chestX = value * 0.24;
  else if (target === 'neck') pose.neckX = value * 0.32;
  else if (target === 'head') pose.headX = value * 0.42;
  else return undefined;
  return { pose, armPose: {} };
}

function bodyTurn(target: string, direction: string | undefined, amount: number): SeatedMotionSample | undefined {
  if (direction !== 'left' && direction !== 'right') return undefined;
  const sign = direction === 'left' ? 1 : -1;
  const value = sign * amount;
  const pose: SeatedMotionPoseOffsets = {};
  if (target === 'spine') pose.spineY = value * 0.18;
  else if (target === 'chest') pose.chestY = value * 0.22;
  else if (target === 'neck') pose.neckY = value * 0.38;
  else if (target === 'head') pose.headY = value * 0.5;
  else return undefined;
  return { pose, armPose: {} };
}

function bodySway(target: string, direction: string | undefined, amount: number): SeatedMotionSample | undefined {
  if (direction !== 'left' && direction !== 'right') return undefined;
  const sign = direction === 'left' ? 1 : -1;
  const value = sign * amount;
  const pose: SeatedMotionPoseOffsets = {};
  if (target === 'chest') pose.chestZ = value * 0.18;
  else if (target === 'head') pose.headZ = value * 0.22;
  else return undefined;
  return { pose, armPose: {} };
}

function pressLap(amount: number): SeatedMotionSample {
  return {
    pose: { armX: amount * 0.06, forearmX: amount * 0.08 },
    armPose: {
      upperArmX: amount * 0.04,
      leftLowerArmX: amount * 0.16,
      rightLowerArmX: amount * 0.16,
      leftLowerArmY: -amount * 0.18,
      rightLowerArmY: amount * 0.18,
      leftHandY: -amount * 0.18,
      rightHandY: amount * 0.18,
      handX: -amount * 0.06,
    },
  };
}

function handRub(side: 'left' | 'right', amount: number): SeatedMotionSample {
  const sign = side === 'left' ? 1 : -1;
  return {
    pose: { armX: amount * 0.08, forearmX: amount * 0.1 },
    armPose: {
      leftLowerArmX: amount * (0.18 + sign * 0.02),
      rightLowerArmX: amount * (0.18 - sign * 0.02),
      leftLowerArmY: -amount * 0.12 * sign,
      rightLowerArmY: amount * 0.12 * sign,
      leftHandY: -amount * 0.2 * sign,
      rightHandY: amount * 0.2 * sign,
      leftHandZ: amount * 0.04 * sign,
      rightHandZ: -amount * 0.04 * sign,
      handX: -amount * 0.04,
    },
  };
}

function armLift(target: string, direction: string | undefined, amount: number): SeatedMotionSample | undefined {
  if (direction !== 'up' && direction !== 'down') return undefined;
  const sign = direction === 'up' ? 1 : -1;
  const value = amount * sign;
  const armPose: SeatedMotionArmOffsets = {};
  applyArmTargets(target, armPose, {
    leftUpperArmZ: -value * 0.18,
    rightUpperArmZ: value * 0.18,
    leftLowerArmX: value * 0.12,
    rightLowerArmX: value * 0.12,
  });
  return { pose: {}, armPose };
}

function armReach(target: string, direction: string | undefined, amount: number): SeatedMotionSample | undefined {
  if (direction !== 'forward' && direction !== 'backward') return undefined;
  const sign = direction === 'forward' ? -1 : 1;
  const value = amount * sign;
  const armPose: SeatedMotionArmOffsets = {};
  applyArmTargets(target, armPose, {
    upperArmX: value * 0.16,
    leftLowerArmX: value * 0.12,
    rightLowerArmX: value * 0.12,
  });
  return { pose: {}, armPose };
}

function applyArmTargets(
  target: string,
  armPose: SeatedMotionArmOffsets,
  offsets: SeatedMotionArmOffsets,
) {
  if (target === 'upperarms' || target === 'upperarm' || target === 'shoulders' || target === 'shoulder') {
    if (offsets.upperArmX) armPose.upperArmX = offsets.upperArmX;
    if (offsets.leftUpperArmZ) armPose.leftUpperArmZ = offsets.leftUpperArmZ;
    if (offsets.rightUpperArmZ) armPose.rightUpperArmZ = offsets.rightUpperArmZ;
  } else if (target === 'leftupperarm' || target === 'leftshoulder') {
    if (offsets.upperArmX) armPose.upperArmX = offsets.upperArmX;
    if (offsets.leftUpperArmZ) armPose.leftUpperArmZ = offsets.leftUpperArmZ;
  } else if (target === 'rightupperarm' || target === 'rightshoulder') {
    if (offsets.upperArmX) armPose.upperArmX = offsets.upperArmX;
    if (offsets.rightUpperArmZ) armPose.rightUpperArmZ = offsets.rightUpperArmZ;
  } else if (target === 'lowerarms' || target === 'lowerarm' || target === 'hands' || target === 'hand') {
    Object.assign(armPose, offsets);
  } else if (target === 'leftlowerarm' || target === 'lefthand') {
    if (offsets.leftLowerArmX) armPose.leftLowerArmX = offsets.leftLowerArmX;
    if (offsets.leftLowerArmY) armPose.leftLowerArmY = offsets.leftLowerArmY;
    if (offsets.leftLowerArmZ) armPose.leftLowerArmZ = offsets.leftLowerArmZ;
    if (offsets.leftHandY) armPose.leftHandY = offsets.leftHandY;
    if (offsets.leftHandZ) armPose.leftHandZ = offsets.leftHandZ;
  } else if (target === 'rightlowerarm' || target === 'righthand') {
    if (offsets.rightLowerArmX) armPose.rightLowerArmX = offsets.rightLowerArmX;
    if (offsets.rightLowerArmY) armPose.rightLowerArmY = offsets.rightLowerArmY;
    if (offsets.rightLowerArmZ) armPose.rightLowerArmZ = offsets.rightLowerArmZ;
    if (offsets.rightHandY) armPose.rightHandY = offsets.rightHandY;
    if (offsets.rightHandZ) armPose.rightHandZ = offsets.rightHandZ;
  }
}

function isArmTarget(target: string) {
  return /shoulder|upperarm|lowerarm|hand|arm/.test(target);
}

function isHandTarget(target: string) {
  return target === 'hands' || target === 'hand' || target === 'lefthand' || target === 'righthand';
}

function emptySample(): SeatedMotionSample {
  return { pose: {}, armPose: {} };
}

function mergeSampleInPlace(target: SeatedMotionSample, add: SeatedMotionSample) {
  target.pose = addRecords(target.pose, add.pose);
  target.armPose = addRecords(target.armPose, add.armPose);
  if (add.gaze) target.gaze = add.gaze;
}

function blendSamples(base: SeatedMotionSample, target: SeatedMotionSample, weight: number): SeatedMotionSample {
  return {
    pose: blendRecords(base.pose, target.pose, weight),
    armPose: blendRecords(base.armPose, target.armPose, weight),
    gaze: weight > 0.5 ? target.gaze ?? base.gaze : base.gaze ?? target.gaze,
  };
}

function scaleSample(sample: SeatedMotionSample, scale: number): SeatedMotionSample {
  const safeScale = Math.max(0, Math.min(1.2, scale));
  return {
    pose: scaleRecord(sample.pose, safeScale),
    armPose: scaleRecord(sample.armPose, safeScale),
    gaze: sample.gaze,
  };
}

function addRecords<T extends Record<string, number | undefined>>(base: T, add: T): T {
  const next = { ...base };
  Object.entries(add).forEach(([key, value]) => {
    if (typeof value !== 'number') return;
    next[key as keyof T] = ((next[key as keyof T] ?? 0) + value) as T[keyof T];
  });
  return next;
}

function blendRecords<T extends Record<string, number | undefined>>(base: T, target: T, weight: number): T {
  const keys = new Set([...Object.keys(base), ...Object.keys(target)]);
  const next = {} as T;
  keys.forEach((key) => {
    const from = base[key as keyof T] ?? 0;
    const to = target[key as keyof T] ?? 0;
    next[key as keyof T] = (from + (to - from) * weight) as T[keyof T];
  });
  return next;
}

function scaleRecord<T extends Record<string, number | undefined>>(record: T, scale: number): T {
  const next = {} as T;
  Object.entries(record).forEach(([key, value]) => {
    if (typeof value === 'number') next[key as keyof T] = (value * scale) as T[keyof T];
  });
  return next;
}

function lineNumberAt(source: string, index: number) {
  return source.slice(0, index).split('\n').length;
}

function normalizeToken(token: string) {
  return token.toLowerCase().replace(/[-\s]/g, '_');
}

function hashSeed(seed: string) {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

function clampAmount(value: number) {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0.2, Math.min(1, value));
}

function roundAmount(value: number) {
  return Math.round(value * 1000) / 1000;
}

function smoothstep(value: number) {
  const x = Math.min(1, Math.max(0, value));
  return x * x * (3 - 2 * x);
}
