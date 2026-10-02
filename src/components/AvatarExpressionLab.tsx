import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { Play, Square } from 'lucide-react';
import { affectPresets, AvatarAsset } from '../lib/avatarConfig';
import type { AvatarBlendshapeDebug } from '../App';
import type { AffectLabel, ResponseLanguage } from '../lib/interviewTypes';

const VrmStage = lazy(() => import('./VrmStage').then((module) => ({ default: module.VrmStage })));
const phases: Array<{ affect: AffectLabel; zh: string; en: string }> = [
  { affect: 'neutral', zh: '傾聽', en: 'Listening' },
  { affect: 'defensive', zh: '防衛', en: 'Guarded' },
  { affect: 'ashamed', zh: '低落', en: 'Downcast' },
  { affect: 'reflective', zh: '修復', en: 'Repair' },
  { affect: 'neutral', zh: '回復', en: 'Return' },
];
const duration = phases.length * 2400;

export function AvatarExpressionLab({ asset, language }: { asset: AvatarAsset; language: ResponseLanguage }) {
  const english = language === 'english';
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [intensity, setIntensity] = useState(0.35);
  const [mouth, setMouth] = useState(true);
  const [debug, setDebug] = useState<AvatarBlendshapeDebug>();
  const [loaded, setLoaded] = useState(false);
  const onStatus = useCallback((status: { avatarLoaded?: boolean; blendshapeDebug?: AvatarBlendshapeDebug }) => {
    if (status.avatarLoaded !== undefined) setLoaded(status.avatarLoaded);
    if (status.blendshapeDebug) setDebug(status.blendshapeDebug);
  }, []);
  useEffect(() => {
    setRunning(false); setElapsed(0); setDebug(undefined); setLoaded(false);
  }, [asset.id]);
  useEffect(() => {
    if (!running) return;
    const start = performance.now();
    const timer = window.setInterval(() => {
      const next = performance.now() - start;
      setElapsed(Math.min(next, duration));
      if (next >= duration) setRunning(false);
    }, 40);
    return () => window.clearInterval(timer);
  }, [running]);
  const phaseIndex = running ? Math.min(phases.length - 1, Math.floor(elapsed / 2400)) : 0;
  const phase = phases[phaseIndex];
  const presetWeights = Object.fromEntries(Object.entries(affectPresets[phase.affect] ?? {}).map(([name, value]) => [name, (value ?? 0) * intensity]));
  const speech = running && mouth && phaseIndex >= 1 && phaseIndex <= 3;
  const caps = debug?.capabilities;
  return <section className="expressionLab" aria-label={english ? 'Expression Lab' : '表情校準'}>
    <header className="expressionLabToolbar">
      <h2>{english ? 'Expression Lab' : '表情校準'}</h2>
      <label>{english ? 'Intensity' : '強度'} <input aria-label={english ? 'Expression intensity' : '表情強度'} type="range" min="0.1" max="0.7" step="0.05" value={intensity} onChange={(e) => setIntensity(Number(e.target.value))} /> {intensity.toFixed(2)}</label>
      <label><input type="checkbox" checked={mouth} onChange={(e) => setMouth(e.target.checked)} />{english ? 'Silent viseme test' : '無聲口型測試'}</label>
      <button type="button" className="iconButton" title={english ? 'Play sequence' : '播放測試序列'} aria-label={english ? 'Play sequence' : '播放測試序列'} disabled={!loaded || running} onClick={() => { setElapsed(0); setRunning(true); }}><Play size={17} /></button>
      <button type="button" className="iconButton" title={english ? 'Stop sequence' : '停止測試序列'} aria-label={english ? 'Stop sequence' : '停止測試序列'} disabled={!running} onClick={() => { setRunning(false); setElapsed(0); }}><Square size={17} /></button>
    </header>
    <div className="expressionLabBody">
      <div className="expressionLabStage">
        <Suspense fallback={<div className="avatarLoading">Loading avatar...</div>}>
          <VrmStage key={asset.id} debugEnabled avatarPath={asset.modelPath} avatarFallbackPaths={asset.fallbackPaths} avatarLabel={asset.displayName}
            expressionWeights={presetWeights} expressionProfile={phase.affect}
            motionIntensity={intensity} motionCue="neutral" caseBaselineMood="neutral" caseRestingCue="neutral"
            caseIdleIntensity={0.3} caseGazePattern="camera_soft" reactionKey="expression-lab" speechLevel={speech ? 0.35 : 0}
            visemePlayback={{ text: '我唔係好想講。其實我有啲驚。', active: speech, durationMs: 7200,
              startedAtMs: 0, clockSource: 'audio', audioCurrentTimeMs: Math.max(0, elapsed - 2400) }}
            lipSyncProfile={asset.lipSyncProfile} autoBlink vrmaFile={null} onStatusChange={onStatus} />
        </Suspense>
      </div>
      <div className="expressionLabReadout">
        <strong>{english ? phase.en : phase.zh}</strong>
        <progress max={duration} value={elapsed} aria-label={english ? 'Sequence progress' : '測試進度'} />
        <dl>
          <dt>{english ? 'Loaded model' : '實際模型'}</dt><dd>{debug?.modelPath ?? asset.modelPath}</dd>
          <dt>{english ? 'Named / effective targets' : '名稱 / 有效形變'}</dt><dd>{caps ? `${caps.namedTargets} / ${caps.effectiveTargets}` : '...'}</dd>
          <dt>{english ? 'Independent groups across meshes' : '各 mesh 獨立形變組'}</dt><dd>{caps?.independentGroups ?? '...'}</dd>
          <dt>{english ? 'Shared-shape groups' : '共用形變組'}</dt><dd>{caps?.aliasedGroups.map((group) => group.join(' = ')).join('; ') || 'none'}</dd>
          <dt>{english ? 'Unsupported ARKit targets' : '不支援的 ARKit 目標'}</dt><dd>{caps?.unsupportedNames.join(', ') || 'none'}</dd>
          <dt>{english ? 'Review status' : '驗收狀態'}</dt><dd>{english ? 'Technical checks only; visual calibration pending' : '技術檢查；視覺強度仍待確認'}</dd>
        </dl>
      </div>
    </div>
  </section>;
}
