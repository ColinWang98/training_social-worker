export type AvatarAsset = {
  id: string;
  displayName: string;
  modelPath: string;
  fallbackPaths: string[];
  sourceFile: string;
  appAssetPath: string;
  fallbackAssetPath?: string;
  generator: string;
  vrmVersion: string;
  author: string;
  credit: string;
  redistribution: string;
  localUseNote: string;
  expressionSupport: 'arkit52' | 'vrm0' | 'none';
  ttsVoice?: string;
  ttsVoiceLabel?: string;
};

export const DEFAULT_AVATAR_ID = 'john-do-arkit';

export const avatarAssets: AvatarAsset[] = [
  {
    id: 'haru',
    displayName: 'Haru',
    modelPath: '/models/client-haru.glb',
    fallbackPaths: ['/models/client-john-do-arkit.vrm', '/models/client-john-do.vrm'],
    sourceFile: '/Users/colin/Downloads/7113633125817327043.glb',
    appAssetPath: 'public/models/client-haru.glb',
    fallbackAssetPath: 'public/models/client-john-do-arkit.vrm',
    generator: 'VRoid Studio 2.1.6 / UniGLTF-2.64.1',
    vrmVersion: 'VRM 0.0 in GLB container',
    author: 'hyona',
    credit: 'Credit required by embedded VRM metadata.',
    redistribution: 'Redistribution is allowed by embedded URL, but modification and commercial use are disallowed.',
    localUseNote: '只限本地原型驗證使用。',
    expressionSupport: 'vrm0',
    ttsVoiceLabel: '環境預設粵語聲線',
  },
  {
    id: 'mobf005',
    displayName: 'MOBF005',
    modelPath: '/models/mobf005.vrm',
    fallbackPaths: ['/models/client-haru.glb', '/models/client-john-do-arkit.vrm'],
    sourceFile: '/Users/colin/Downloads/uploads_files_4768765_MOBF005.vrm',
    appAssetPath: 'public/models/mobf005.vrm',
    fallbackAssetPath: 'public/models/client-haru.glb',
    generator: 'saturday06_blender_vrm_exporter_experimental_2.17.7',
    vrmVersion: 'VRM 0.0',
    author: 'Embedded metadata does not name an author',
    credit: 'Embedded license URL says credit notation is unnecessary; keep source note for local provenance.',
    redistribution: 'Embedded license URL disallows redistribution; local prototype use only.',
    localUseNote: '女性外觀候選；表情 blendshape 綁定缺失，適合先驗證外觀與女性粵語聲線。',
    expressionSupport: 'none',
    ttsVoice: 'yue-HK-Chirp3-HD-Achernar',
    ttsVoiceLabel: '女性粵語 Chirp3 TTS',
  },
  {
    id: 'john-do-arkit',
    displayName: 'John Do ARKit',
    modelPath: '/models/client-john-do-arkit.vrm',
    fallbackPaths: ['/models/client-john-do.vrm'],
    sourceFile: 'public/models/client-john-do.vrm',
    appAssetPath: 'public/models/client-john-do-arkit.vrm',
    fallbackAssetPath: 'public/models/client-john-do.vrm',
    generator: 'VRoidShaper processed VRM',
    vrmVersion: 'VRM 1.0 compatible runtime asset',
    author: 'John Do embedded metadata',
    credit: 'Credit required by embedded VRM metadata.',
    redistribution: 'Do not redistribute outside the local prototype until licensing is clarified.',
    localUseNote: 'ARKit 52 blendshape 測試模型。',
    expressionSupport: 'arkit52',
    ttsVoiceLabel: '環境預設粵語聲線',
  },
];

export const defaultAvatarAsset = avatarAssets.find((asset) => asset.id === DEFAULT_AVATAR_ID) ?? avatarAssets[0];

export const AVATAR_PATH = defaultAvatarAsset.modelPath;
export const AVATAR_FALLBACK_PATH = defaultAvatarAsset.fallbackPaths[0];
export const AVATAR_SECONDARY_FALLBACK_PATH = defaultAvatarAsset.fallbackPaths[1];
export const avatarMetadata = defaultAvatarAsset;

export type VrmExpressionName =
  | 'neutral'
  | 'happy'
  | 'angry'
  | 'sad'
  | 'relaxed'
  | 'surprised'
  | 'blink'
  | 'blinkLeft'
  | 'blinkRight'
  | 'aa'
  | 'ih'
  | 'ou'
  | 'ee'
  | 'oh';

export type ExpressionWeights = Partial<Record<VrmExpressionName, number>>;

export type ArkitBlendshapeName =
  | 'browDownLeft'
  | 'browDownRight'
  | 'browInnerUp'
  | 'browOuterUpLeft'
  | 'browOuterUpRight'
  | 'cheekPuff'
  | 'cheekSquintLeft'
  | 'cheekSquintRight'
  | 'eyeBlinkLeft'
  | 'eyeBlinkRight'
  | 'eyeLookDownLeft'
  | 'eyeLookDownRight'
  | 'eyeLookInLeft'
  | 'eyeLookInRight'
  | 'eyeLookOutLeft'
  | 'eyeLookOutRight'
  | 'eyeLookUpLeft'
  | 'eyeLookUpRight'
  | 'eyeSquintLeft'
  | 'eyeSquintRight'
  | 'eyeWideLeft'
  | 'eyeWideRight'
  | 'jawForward'
  | 'jawLeft'
  | 'jawOpen'
  | 'jawRight'
  | 'mouthClose'
  | 'mouthDimpleLeft'
  | 'mouthDimpleRight'
  | 'mouthFrownLeft'
  | 'mouthFrownRight'
  | 'mouthFunnel'
  | 'mouthLeft'
  | 'mouthLowerDownLeft'
  | 'mouthLowerDownRight'
  | 'mouthPressLeft'
  | 'mouthPressRight'
  | 'mouthPucker'
  | 'mouthRight'
  | 'mouthRollLower'
  | 'mouthRollUpper'
  | 'mouthShrugLower'
  | 'mouthShrugUpper'
  | 'mouthSmileLeft'
  | 'mouthSmileRight'
  | 'mouthStretchLeft'
  | 'mouthStretchRight'
  | 'mouthUpperUpLeft'
  | 'mouthUpperUpRight'
  | 'noseSneerLeft'
  | 'noseSneerRight'
  | 'tongueOut';

export type ArkitBlendshapeWeights = Partial<Record<ArkitBlendshapeName, number>>;

export const affectPresets: Record<string, ExpressionWeights> = {
  neutral: { neutral: 0.18 },
  defensive: { angry: 0.46, sad: 0.2 },
  ashamed: { sad: 0.66, relaxed: 0.08 },
  reflective: { relaxed: 0.5 },
  anxious: { sad: 0.42, surprised: 0.26 },
  irritated: { angry: 0.62 },
  tired: { sad: 0.44, relaxed: 0.2 },
  withdrawn: { sad: 0.58, relaxed: 0.16 },
  sad: { sad: 0.62 },
};

export const expressionNames: VrmExpressionName[] = [
  'neutral',
  'happy',
  'angry',
  'sad',
  'relaxed',
  'surprised',
  'blink',
  'blinkLeft',
  'blinkRight',
];

export const mouthNames: VrmExpressionName[] = ['aa', 'ih', 'ou', 'ee', 'oh'];

export const motionPrompts = [
  '坐下的成人服務對象輕微向後靠，姿態防衛。',
  '坐下的成人服務對象低頭，緊張地搓手。',
  '坐下的成人服務對象不安地移動，避開眼神接觸。',
  '疲倦的服務對象低下頭，肩膀下垂。',
  '坐下的成人服務對象微微向前，慢慢點頭。',
];

export const motionCuePrompts: Record<string, string> = {
  neutral: '坐下的服務對象保持中性但略為防衛的姿態。',
  look_down: '坐下的服務對象低頭，肩膀微微下垂。',
  avoid_eye_contact: '坐下的服務對象不安地移動，避開眼神接觸。',
  rub_hands: '坐下的服務對象一邊說話一邊緊張地搓手。',
  lean_back: '坐下的服務對象輕微向後靠，姿態防衛。',
  slow_nod: '坐下的服務對象微微向前，慢慢點頭。',
};
