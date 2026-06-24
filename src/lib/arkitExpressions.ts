import { AffectLabel, LipSyncTimeline, MouthViseme } from './interviewTypes';
import { ArkitBlendshapeWeights, ExpressionWeights } from './avatarConfig';

export type CantoneseViseme = MouthViseme;

export type CantoneseVisemeFrame = {
  atMs: number;
  durationMs: number;
  viseme: CantoneseViseme;
  char: string;
};

export function expressionProfileForAffect(
  affect: AffectLabel | undefined,
  expressionWeights: ExpressionWeights,
  intensity: number,
): ArkitBlendshapeWeights {
  const normalizedIntensity = clamp(intensity, 0.2, 1);
  const inferred = affect ?? inferAffect(expressionWeights);
  const base = profileMap[inferred] ?? profileMap.neutral;
  return scaleWeights(base, normalizedIntensity);
}

export function buildCantoneseVisemeTimeline(text: string, durationMs: number): CantoneseVisemeFrame[] {
  const chars = Array.from(text).filter((char) => !/\s/.test(char));
  if (chars.length === 0) return [];
  const safeDuration = Number.isFinite(durationMs) && durationMs > 300
    ? durationMs
    : estimateCantoneseSpeechDuration(text);
  const totalUnits = chars.reduce((sum, char) => sum + charDurationUnit(char), 0);
  let cursor = 0;
  return chars.map((char) => {
    const unit = charDurationUnit(char);
    const frameDuration = Math.max(58, (safeDuration * unit) / Math.max(totalUnits, 1));
    const frame = {
      atMs: cursor,
      durationMs: frameDuration,
      viseme: visemeForChar(char),
      char,
    };
    cursor += frameDuration;
    return frame;
  });
}

export function buildRhubarbVisemeTimeline(lipSync: LipSyncTimeline | undefined): CantoneseVisemeFrame[] {
  if (!lipSync?.mappedVisemes?.length) return [];
  return lipSync.mappedVisemes
    .filter((cue) => Number.isFinite(cue.startMs) && Number.isFinite(cue.endMs) && cue.endMs > cue.startMs)
    .map((cue) => ({
      atMs: cue.startMs,
      durationMs: cue.endMs - cue.startMs,
      viseme: cue.viseme,
      char: '',
    }));
}

export function estimateCantoneseSpeechDuration(text: string) {
  const charCount = Array.from(text).filter((char) => !/\s/.test(char)).length;
  return Math.max(900, Math.min(14000, charCount * 125));
}

export function visemeWeightsForTime(
  timeline: CantoneseVisemeFrame[],
  elapsedMs: number,
  speechLevel: number,
  options: { active?: boolean; minVisibleScale?: number } = {},
): { weights: ArkitBlendshapeWeights; activeViseme: CantoneseViseme | 'none'; activeChar: string } {
  if (timeline.length === 0 || options.active === false) {
    return { weights: {}, activeViseme: 'none', activeChar: '' };
  }
  const firstFrame = timeline[0];
  const lastFrame = timeline[timeline.length - 1];
  const timelineEndMs = lastFrame.atMs + lastFrame.durationMs;
  if (elapsedMs > timelineEndMs + 40) {
    return { weights: {}, activeViseme: 'none', activeChar: '' };
  }
  const frame = timeline.find((item) => elapsedMs >= item.atMs && elapsedMs < item.atMs + item.durationMs);
  if (!frame) {
    const restScale = Math.max(0.08, options.minVisibleScale ?? 0.14);
    return {
      weights: scaleWeights(visemeWeightMap.rest ?? {}, restScale),
      activeViseme: elapsedMs < firstFrame.atMs ? 'rest' : 'none',
      activeChar: '',
    };
  }
  const local = clamp((elapsedMs - frame.atMs) / Math.max(frame.durationMs, 1), 0, 1);
  const attack = clamp(local / 0.18, 0, 1);
  const release = clamp((1 - local) / 0.22, 0, 1);
  const envelope = smoothstep(Math.min(attack, release));
  const speechModulation = 0.72 + clamp(speechLevel, 0, 1) * 0.28;
  const scale = speechModulation * (0.52 + envelope * 0.48);
  return {
    weights: scaleWeights(visemeWeightMap[frame.viseme] ?? {}, scale),
    activeViseme: frame.viseme,
    activeChar: frame.char,
  };
}

function inferAffect(weights: ExpressionWeights): AffectLabel {
  const angry = weights.angry ?? 0;
  const sad = weights.sad ?? 0;
  const surprised = weights.surprised ?? 0;
  const relaxed = weights.relaxed ?? 0;
  if (angry > 0.42) return 'irritated';
  if (angry > 0.1) return 'defensive';
  if (surprised > 0.1 && sad > 0.1) return 'anxious';
  if (sad > 0.45 && relaxed > 0.05) return 'withdrawn';
  if (sad > 0.35) return 'sad';
  if (relaxed > 0.25) return 'reflective';
  return 'neutral';
}

function scaleWeights(weights: ArkitBlendshapeWeights, scale: number): ArkitBlendshapeWeights {
  return Object.fromEntries(
    Object.entries(weights).map(([name, value]) => [name, clamp((value ?? 0) * scale, 0, 1)]),
  ) as ArkitBlendshapeWeights;
}

function visemeForChar(char: string): CantoneseViseme {
  if ('。！？!?，、；;,.'.includes(char)) return 'closed';
  if ('啊呀吓啦喇嘛嗎罷吧哈家加架假下怕話嘩'.includes(char)) return 'open';
  if ('唔冇無好到做我過個哦喎窩和和咗左咁講抗'.includes(char)) return 'rounded';
  if ('你知啲的呢哩依以已而幾其自己事係系起比俾'.includes(char)) return 'front';
  return 'soft';
}

function charDurationUnit(char: string) {
  if ('。！？!?'.includes(char)) return 2.4;
  if ('，、；;,.'.includes(char)) return 1.6;
  return 1;
}

function clamp(value: number, min = 0, max = 1) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function smoothstep(value: number) {
  const x = clamp(value, 0, 1);
  return x * x * (3 - 2 * x);
}

const profileMap: Record<string, ArkitBlendshapeWeights> = {
  neutral: {
    mouthClose: 0.08,
  },
  defensive: {
    browDownLeft: 0.42,
    browDownRight: 0.42,
    eyeSquintLeft: 0.18,
    eyeSquintRight: 0.18,
    mouthPressLeft: 0.28,
    mouthPressRight: 0.28,
    mouthFrownLeft: 0.14,
    mouthFrownRight: 0.14,
  },
  irritated: {
    browDownLeft: 0.62,
    browDownRight: 0.62,
    eyeSquintLeft: 0.32,
    eyeSquintRight: 0.32,
    mouthFrownLeft: 0.28,
    mouthFrownRight: 0.28,
    mouthPressLeft: 0.2,
    mouthPressRight: 0.2,
  },
  ashamed: {
    browInnerUp: 0.24,
    eyeSquintLeft: 0.08,
    eyeSquintRight: 0.08,
    mouthPressLeft: 0.32,
    mouthPressRight: 0.32,
    mouthFrownLeft: 0.24,
    mouthFrownRight: 0.24,
  },
  anxious: {
    browInnerUp: 0.34,
    eyeWideLeft: 0.3,
    eyeWideRight: 0.3,
    mouthStretchLeft: 0.2,
    mouthStretchRight: 0.2,
    mouthPressLeft: 0.16,
    mouthPressRight: 0.16,
  },
  withdrawn: {
    browInnerUp: 0.2,
    eyeSquintLeft: 0.12,
    eyeSquintRight: 0.12,
    mouthFrownLeft: 0.28,
    mouthFrownRight: 0.28,
    mouthClose: 0.18,
  },
  sad: {
    browInnerUp: 0.26,
    mouthFrownLeft: 0.36,
    mouthFrownRight: 0.36,
    mouthClose: 0.14,
  },
  reflective: {
    browInnerUp: 0.12,
    mouthClose: 0.1,
    mouthSmileLeft: 0.06,
    mouthSmileRight: 0.06,
  },
  happy: {
    cheekSquintLeft: 0.16,
    cheekSquintRight: 0.16,
    mouthSmileLeft: 0.32,
    mouthSmileRight: 0.32,
  },
};

const visemeWeightMap: Record<CantoneseViseme, ArkitBlendshapeWeights> = {
  rest: {
    mouthClose: 0.18,
    jawOpen: 0.01,
  },
  closed: {
    mouthClose: 0.5,
    jawOpen: 0.02,
  },
  open: {
    jawOpen: 0.62,
    mouthLowerDownLeft: 0.22,
    mouthLowerDownRight: 0.22,
    mouthUpperUpLeft: 0.12,
    mouthUpperUpRight: 0.12,
  },
  rounded: {
    jawOpen: 0.28,
    mouthFunnel: 0.38,
    mouthPucker: 0.34,
  },
  front: {
    jawOpen: 0.22,
    mouthStretchLeft: 0.34,
    mouthStretchRight: 0.34,
  },
  soft: {
    jawOpen: 0.28,
    mouthClose: 0.08,
  },
  wide: {
    jawOpen: 0.72,
    mouthLowerDownLeft: 0.26,
    mouthLowerDownRight: 0.26,
    mouthUpperUpLeft: 0.14,
    mouthUpperUpRight: 0.14,
  },
  fv: {
    jawOpen: 0.12,
    mouthPressLeft: 0.24,
    mouthPressRight: 0.24,
    mouthLowerDownLeft: 0.12,
    mouthLowerDownRight: 0.12,
  },
};
