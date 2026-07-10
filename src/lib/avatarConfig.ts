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
  lipSyncProfile: AvatarLipSyncProfile;
  ttsVoice?: string;
  ttsVoiceLabel?: string;
};

export type AvatarLipSyncProfile = {
  id: 'john-do-vroid' | 'streamoji-conservative' | 'generic';
  mouthScale: number;
  emotionMouthSuppressionWhileSpeaking: number;
  jawOpenMax: number;
  mouthCloseMax: number;
};

export const avatarLipSyncProfiles: Record<AvatarLipSyncProfile['id'], AvatarLipSyncProfile> = {
  'john-do-vroid': {
    id: 'john-do-vroid',
    mouthScale: 1,
    emotionMouthSuppressionWhileSpeaking: 0.85,
    jawOpenMax: 0.78,
    mouthCloseMax: 0.55,
  },
  'streamoji-conservative': {
    id: 'streamoji-conservative',
    mouthScale: 0.72,
    emotionMouthSuppressionWhileSpeaking: 0.25,
    jawOpenMax: 0.46,
    mouthCloseMax: 0.22,
  },
  generic: {
    id: 'generic',
    mouthScale: 0.78,
    emotionMouthSuppressionWhileSpeaking: 0.5,
    jawOpenMax: 0.55,
    mouthCloseMax: 0.32,
  },
};

export const DEFAULT_AVATAR_ID = 'john-do-arkit';

export const avatarAssets: AvatarAsset[] = [
  {
    id: 'streamoji-0sfg',
    displayName: 'Streamoji ARKit GLB',
    modelPath: '/models/streamoji-avatar-0sFGvLNDtV76PHuF5Rb9.glb',
    fallbackPaths: ['/models/client-john-do-arkit.vrm', '/models/client-john-do.vrm'],
    sourceFile: '/Users/colin/Downloads/avatar-0sFGvLNDtV76PHuF5Rb9 (1).glb',
    appAssetPath: 'public/models/streamoji-avatar-0sFGvLNDtV76PHuF5Rb9.glb',
    fallbackAssetPath: 'public/models/client-john-do-arkit.vrm',
    generator: 'Streamoji Avatar Generator',
    vrmVersion: 'glTF 2.0 GLB, non-VRM',
    author: 'Streamoji Avatars',
    credit: 'Streamoji Avatars; keep source and license terms with local prototype records.',
    redistribution: 'Local prototype testing only unless Streamoji account/license terms allow redistribution.',
    localUseNote: '普通 GLB 候選；支援 ARKit 52 blendshape，VRM 坐姿骨骼 runtime 不適用。',
    expressionSupport: 'arkit52',
    lipSyncProfile: avatarLipSyncProfiles['streamoji-conservative'],
    ttsVoiceLabel: '環境預設粵語聲線',
  },
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
    lipSyncProfile: avatarLipSyncProfiles.generic,
    ttsVoiceLabel: '環境預設粵語聲線',
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
    lipSyncProfile: avatarLipSyncProfiles['john-do-vroid'],
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
