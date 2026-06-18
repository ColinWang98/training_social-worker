import { useEffect, useState } from 'react';
import { Activity, CheckCircle2, Eye, EyeOff, FileText, Network, ShieldAlert, Sparkles, X } from 'lucide-react';
import { getKnownFacts, getRecentEvents, getUnrevealedFacts } from '../lib/caseEngine';
import {
  CaseProfile,
  ClientResponse,
  EvidenceSummary,
  MotionCue,
  PostSessionSupervisorReport,
  ResponseLanguage,
  RetrievalOptions,
  SimulationMethod,
  TrainingViewMode,
} from '../lib/interviewTypes';
import type { AvatarBlendshapeDebug, AvatarMotionDebug } from '../App';
import { caseDisplay, motionPrompt, observableLabel, t } from '../lib/i18n';

type CasePanelProps = {
  caseProfile: CaseProfile;
  caseProfiles: CaseProfile[];
  evidenceSummary: EvidenceSummary | null;
  avatarDirective: ClientResponse['avatarDirective'] | null;
  realismAssessment: ClientResponse['realismAssessment'] | null;
  adaptivePolicySnapshot: ClientResponse['adaptivePolicySnapshot'] | null;
  simulationMethod: SimulationMethod;
  retrievalOptions: RetrievalOptions;
  simulationStrategySnapshot: ClientResponse['simulationStrategySnapshot'] | null;
  sessionContinuitySnapshot: ClientResponse['sessionContinuitySnapshot'] | null;
  contextConsistencyAssessment: ClientResponse['contextConsistencyAssessment'] | null;
  profileGroundingSnapshot: ClientResponse['profileGroundingSnapshot'] | null;
  pieContextSnapshot: ClientResponse['pieContextSnapshot'] | null;
  safetyFlags: string[];
  safetyHint: string | null;
  postSessionReport: PostSessionSupervisorReport | null;
  isFinalReviewPending: boolean;
  canEndSession: boolean;
  motionCue: MotionCue;
  statusMessage: string;
  avatarBlendshapeDebug: AvatarBlendshapeDebug | null;
  avatarMotionDebug: AvatarMotionDebug | null;
  onCaseChange: (caseId: string) => void;
  onEndSession: () => void;
  onSimulationMethodChange: (method: SimulationMethod) => void;
  onRetrievalOptionsChange: (options: RetrievalOptions) => void;
  onVrmaFile: (file: File | null) => void;
  uiLanguage: ResponseLanguage;
};

export function CasePanel({
  caseProfile,
  caseProfiles,
  evidenceSummary,
  avatarDirective,
  realismAssessment,
  adaptivePolicySnapshot,
  simulationMethod,
  retrievalOptions,
  simulationStrategySnapshot,
  sessionContinuitySnapshot,
  contextConsistencyAssessment,
  profileGroundingSnapshot,
  pieContextSnapshot,
  safetyFlags,
  safetyHint,
  postSessionReport,
  isFinalReviewPending,
  canEndSession,
  motionCue,
  statusMessage,
  avatarBlendshapeDebug,
  avatarMotionDebug,
  onCaseChange,
  onEndSession,
  onSimulationMethodChange,
  onRetrievalOptionsChange,
  onVrmaFile,
  uiLanguage,
}: CasePanelProps) {
  const state = caseProfile.psychologicalState;
  const knownFacts = getKnownFacts(caseProfile);
  const unrevealedFacts = getUnrevealedFacts(caseProfile);
  const [viewMode, setViewMode] = useState<TrainingViewMode>('trainee');
  const [isReportDialogOpen, setIsReportDialogOpen] = useState(false);
  const isInstructor = viewMode === 'instructor';

  useEffect(() => {
    setViewMode('trainee');
    setIsReportDialogOpen(false);
  }, [caseProfile.id]);

  useEffect(() => {
    setIsReportDialogOpen(Boolean(postSessionReport));
  }, [postSessionReport]);

  useEffect(() => {
    if (!isReportDialogOpen) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsReportDialogOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isReportDialogOpen]);

  return (
    <aside className="casePanel" aria-label={t(uiLanguage, 'panelAria')}>
      <section className="sideSection modeSection">
        <div className="sectionTitle">
          {isInstructor ? <Eye size={16} /> : <EyeOff size={16} />}
          <h2>{t(uiLanguage, 'displayMode')}</h2>
        </div>
        <div className="modeSwitch" role="group" aria-label={t(uiLanguage, 'displayMode')}>
          <button
            className={viewMode === 'trainee' ? 'active' : ''}
            type="button"
            onClick={() => setViewMode('trainee')}
          >
            {t(uiLanguage, 'traineeMode')}
          </button>
          <button
            className={viewMode === 'instructor' ? 'active' : ''}
            type="button"
            onClick={() => setViewMode('instructor')}
          >
            {t(uiLanguage, 'instructorMode')}
          </button>
        </div>
        <p className="mutedText">
          {isInstructor
            ? t(uiLanguage, 'instructorModeHint')
            : t(uiLanguage, 'traineeModeHint')}
        </p>
      </section>

      <section className="sideSection">
        <div className="sectionTitle">
          <Activity size={16} />
          <h2>{t(uiLanguage, 'caseState')}</h2>
        </div>
        <label className="caseSelector">
          <span>{t(uiLanguage, 'issueType')}</span>
          <select value={caseProfile.id} onChange={(event) => onCaseChange(event.target.value)}>
            {caseProfiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {caseDisplay(profile, uiLanguage).issueLabel}
              </option>
            ))}
          </select>
        </label>
        <h3 className="localizedTitle">{caseDisplay(caseProfile, uiLanguage).title}</h3>
        <p className="caseIntro">{caseDisplay(caseProfile, uiLanguage).context}</p>
        {isInstructor ? (
          <>
            <div className="caseMeta">
              {caseProfile.issueTags.map((tag) => (
                <span key={tag}>{tag}</span>
              ))}
              <span>階段：{caseProfile.simulatorStage}</span>
            </div>
            <div className="metricGrid">
              <Metric label="困擾程度" value={state.distressLevel} max={4} />
              <Metric label="壓力" value={state.stressLevel} max={10} />
              <Metric label="自我價值" value={state.selfEsteem} max={10} />
              <Metric label="社交連結" value={state.socialConnection} max={10} />
              <Metric label="學業壓力" value={state.academicPressure} max={10} />
              <Metric label="開放程度" value={state.clientOpenness} max={10} />
            </div>
          </>
        ) : (
          <div className="observableState">
            <span>{t(uiLanguage, 'observableState')}</span>
            <strong>{observableStateLabel(caseProfile, avatarDirective, uiLanguage)}</strong>
            <p>{observableStateHint(caseProfile, motionCue, uiLanguage)}</p>
          </div>
        )}
      </section>

      {isInstructor && (
        <>
          <section className="sideSection">
            <div className="sectionTitle">
              <Activity size={16} />
              <h2>Simulation Method</h2>
            </div>
            <label className="caseSelector">
              <span>策略</span>
              <select
                value={simulationMethod}
                onChange={(event) => onSimulationMethodChange(event.target.value as SimulationMethod)}
              >
                {simulationMethodOptions.map((method) => (
                  <option key={method.value} value={method.value}>
                    {method.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="mutedText">
              {simulationMethodOptions.find((method) => method.value === simulationMethod)?.description}
            </p>
            <label className="checkboxLine">
              <input
                type="checkbox"
                checked={Boolean(retrievalOptions.embeddingEnabled)}
                onChange={(event) => onRetrievalOptionsChange({ embeddingEnabled: event.target.checked })}
              />
              <span>本地語義檢索</span>
            </label>
            <p className="mutedText">
              關閉時使用原本 SQLite FTS；開啟後才嘗試本地 embedding rerank。若 cache 或模型不可用，系統會自動回退。
            </p>
            {simulationStrategySnapshot && (
              <>
                <TagRow label="Prompt Focus" values={simulationStrategySnapshot.promptFocus} />
                <TagRow label="回應約束" values={simulationStrategySnapshot.responseConstraints} />
                <TagRow label="檢索加權來源" values={simulationStrategySnapshot.retrievalBoostSources} />
                <TagRow label="評估重點" values={simulationStrategySnapshot.evaluatorFocus} />
              </>
            )}
          </section>

          <section className="sideSection">
            <div className="sectionTitle">
              <FileText size={16} />
              <h2>本輪檢索證據</h2>
            </div>
            {evidenceSummary ? (
              <>
                <p className="mutedText">本輪檢索到 {evidenceSummary.cardCount} 張證據卡。</p>
                <div className="evidenceSourceGrid">
                  {Object.entries(evidenceSummary.sources).map(([source, count]) => (
                    <span key={source}>
                      {source}: {count}
                    </span>
                  ))}
                </div>
                <TagRow label="議題標籤" values={evidenceSummary.issueTags} />
                <TagRow label="風險標籤" values={evidenceSummary.riskSignals} />
                {evidenceSummary.retrievalDebug && (
                  <div className="debriefGrid">
                    <DirectiveItem label="檢索模式" value={evidenceSummary.retrievalDebug.retrievalMode ?? 'sqlite-fts'} />
                    <DirectiveItem label="Embedding" value={evidenceSummary.retrievalDebug.embeddingStatus ?? 'unknown'} />
                    <DirectiveItem label="FTS 候選" value={`${evidenceSummary.retrievalDebug.ftsCandidateCount ?? 0}`} />
                    <DirectiveItem label="Embedding 候選" value={`${evidenceSummary.retrievalDebug.embeddedCandidateCount ?? 0}`} />
                    <DirectiveItem
                      label="Cosine"
                      value={
                        evidenceSummary.retrievalDebug.cosineRange
                          ? evidenceSummary.retrievalDebug.cosineRange.map((score) => score.toFixed(2)).join(' - ')
                          : 'n/a'
                      }
                    />
                  </div>
                )}
              </>
            ) : (
              <p className="mutedText">服務對象回應生成後，這裡會顯示本輪檢索來源摘要。</p>
            )}
          </section>

          <section className="sideSection">
            <div className="sectionTitle">
              <FileText size={16} />
              <h2>近期事件</h2>
            </div>
            <div className="eventList">
              {getRecentEvents(caseProfile).map((event) => (
                <div className="eventRow" key={`${event.day}-${event.description}`}>
                  <span className={event.impactScore >= 0 ? 'impactPositive' : 'impactNegative'}>
                    {event.impactScore > 0 ? '+' : ''}
                    {event.impactScore}
                  </span>
                  <p>{event.description}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="sideSection">
            <div className="sectionTitle">
              <Network size={16} />
              <h2>關係圖</h2>
            </div>
            <div className="relationshipList">
              {caseProfile.relationships.map((relationship) => (
                <div className="relationshipRow" key={relationship.person}>
                  <div>
                    <strong>{relationship.person}</strong>
                    <span>{relationship.role}</span>
                  </div>
                  <div className="relationshipScores">
                    <span>C {relationship.closeness}</span>
                    <span>T {relationship.trust}</span>
                    <span>X {relationship.conflict}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </>
      )}

      <section className="sideSection">
        <div className="sectionTitle">
          <Sparkles size={16} />
          <h2>{t(uiLanguage, 'supervision')}</h2>
        </div>
        <p className="mutedText">
          {t(uiLanguage, 'supervisionDuring')}
        </p>
        {safetyHint && (
          <div className="riskHint">
            <ShieldAlert size={15} />
            <span>{safetyHint}</span>
          </div>
        )}
        <button
          className="sessionEndButton"
          type="button"
          disabled={(!canEndSession && !postSessionReport) || isFinalReviewPending}
          onClick={() => {
            if (postSessionReport) {
              setIsReportDialogOpen(true);
              return;
            }
            onEndSession();
          }}
        >
          <CheckCircle2 size={16} />
          {isFinalReviewPending ? t(uiLanguage, 'generatingReport') : postSessionReport ? t(uiLanguage, 'viewReport') : t(uiLanguage, 'endSession')}
        </button>
        {postSessionReport ? (
          <div className="reportSummaryCard">
            <strong>{t(uiLanguage, 'reportReady')}</strong>
            <p>{postSessionReport.overallSummary}</p>
          </div>
        ) : (
          <p className="mutedText">{t(uiLanguage, 'endSessionHint')}</p>
        )}
      </section>

      <section className="sideSection">
        <h2>{t(uiLanguage, 'revealedInfo')}</h2>
        {isInstructor && (
          <p className="mutedText">
            {t(uiLanguage, 'knownUnknownCount', { known: knownFacts.length, unknown: unrevealedFacts.length })}
          </p>
        )}
        {!isInstructor && knownFacts.length === 0 && (
          <p className="mutedText">{t(uiLanguage, 'noRevealedFacts')}</p>
        )}
        <div className="factList">
          {knownFacts.map((fact) => (
            <span key={fact.id}>{fact.label}</span>
          ))}
        </div>
      </section>

      {isInstructor && (
        <>
          <section className="sideSection">
            <div className="sectionTitle">
              <Sparkles size={16} />
              <h2>Avatar 基準狀態</h2>
            </div>
            <div className="avatarDirectiveGrid" aria-label="Avatar 基準狀態">
              <DirectiveItem label="基準情緒" value={caseProfile.avatarBaseline.baselineMood} />
              <DirectiveItem label="休息姿態" value={caseProfile.avatarBaseline.restingCue} />
              <DirectiveItem label="眼神模式" value={caseProfile.avatarBaseline.gazePattern} />
              <DirectiveItem label="Idle 強度" value={`${Math.round(caseProfile.avatarBaseline.idleIntensity * 100)}%`} />
            </div>
            <p className="mutedText">{caseProfile.avatarBaseline.postureLabel}</p>
          </section>

          <section className="sideSection">
            <div className="sectionTitle">
              <FileText size={16} />
              <h2>Social Work Context Model</h2>
            </div>
            <p className="mutedText">{caseProfile.socialWorkContextModel.selfNarrative}</p>
            <TagRow label="核心信念" values={caseProfile.socialWorkContextModel.coreBeliefs} />
            <TagRow label="羞恥觸發" values={caseProfile.socialWorkContextModel.shameTriggers} />
            <TagRow label="逃避模式" values={caseProfile.socialWorkContextModel.avoidancePatterns} />
            <TagRow label="透露規則" values={caseProfile.socialWorkContextModel.disclosureRules} />
          </section>

          <section className="sideSection">
            <div className="sectionTitle">
              <Network size={16} />
              <h2>Grounding / PIE</h2>
            </div>
            {profileGroundingSnapshot || pieContextSnapshot ? (
              <>
                <div className="avatarDirectiveGrid">
                  <DirectiveItem label="Profile" value={profileGroundingSnapshot?.profileId ?? 'case spec'} />
                  <DirectiveItem label="生成模式" value={profileGroundingSnapshot?.generationMode ?? 'case_spec'} />
                  <DirectiveItem label="PIE 來源" value={pieContextSnapshot?.source ?? 'case_spec'} />
                  <DirectiveItem label="Evidence Cards" value={`${profileGroundingSnapshot?.sourceEvidenceSummary?.cardCount ?? 0}`} />
                </div>
                <TagRow label="Reflection keys" values={profileGroundingSnapshot?.reflectionKeys ?? []} />
                <TagRow label="Micro fields" values={Object.keys(pieContextSnapshot?.microSystem ?? {})} />
                <TagRow label="Meso fields" values={Object.keys(pieContextSnapshot?.mesoSystem ?? {})} />
                <TagRow label="Macro fields" values={Object.keys(pieContextSnapshot?.macroSystem ?? {})} />
              </>
            ) : (
              <p className="mutedText">服務對象回應後，這裡會顯示本輪使用的 grounding profile 與 micro/meso/macro 摘要。</p>
            )}
          </section>

          <section className="sideSection">
            <div className="sectionTitle">
              <Activity size={16} />
              <h2>Adaptive / Continuity</h2>
            </div>
            {adaptivePolicySnapshot ? (
              <>
                <div className="avatarDirectiveGrid">
                  <DirectiveItem label="目標阻抗" value={adaptivePolicySnapshot.targetResistanceLevel} />
                  <DirectiveItem
                    label="開放變化"
                    value={`${adaptivePolicySnapshot.targetOpennessDeltaRange[0]} 至 ${adaptivePolicySnapshot.targetOpennessDeltaRange[1]}`}
                  />
                  <DirectiveItem label="透露深度" value={`${adaptivePolicySnapshot.allowedDisclosureDepth}`} />
                </div>
                <TagRow label="回應約束" values={adaptivePolicySnapshot.responseStyleConstraints} />
                <TagRow label="情緒提示" values={adaptivePolicySnapshot.requiredAffectHints} />
                <TagRow label="動作提示" values={adaptivePolicySnapshot.avatarBehaviorHints} />
              </>
            ) : (
              <p className="mutedText">服務對象回應後，這裡會顯示本輪 Adaptive-VP 約束。</p>
            )}
            {sessionContinuitySnapshot && (
              <>
                <div className="avatarDirectiveGrid">
                  <DirectiveItem label="關係記憶" value={sessionContinuitySnapshot.relationshipMemory} />
                  <DirectiveItem label="信任軌跡" value={sessionContinuitySnapshot.trustTrajectory.join(' → ')} />
                </div>
                <TagRow label="關係破裂" values={sessionContinuitySnapshot.ruptureEvents} />
                <TagRow label="修復嘗試" values={sessionContinuitySnapshot.repairAttempts} />
                <TagRow label="迴避話題" values={sessionContinuitySnapshot.avoidedTopics} />
                <TagRow label="語言模式" values={sessionContinuitySnapshot.recurringLanguagePatterns} />
                {sessionContinuitySnapshot.sessionReflection && (
                  <p className="mutedText">
                    {sessionContinuitySnapshot.sessionReflection.trustState}：
                    {sessionContinuitySnapshot.sessionReflection.nextResponseTone}
                  </p>
                )}
              </>
            )}
            {contextConsistencyAssessment && (
              <>
                <div className="avatarDirectiveGrid">
                  <DirectiveItem label="Context 一致性" value={`${contextConsistencyAssessment.score.toFixed(1)}/10`} />
                </div>
                <TagRow label="匹配信念" values={contextConsistencyAssessment.matchedBeliefs} />
                <TagRow label="違反信念" values={contextConsistencyAssessment.violatedBeliefs} />
                <TagRow label="透露規則提示" values={contextConsistencyAssessment.disclosureRuleNotes} />
              </>
            )}
          </section>

          <DebriefSection
            caseProfile={caseProfile}
            evidenceSummary={evidenceSummary}
            postSessionReport={postSessionReport}
            knownFacts={knownFacts}
            unrevealedFacts={unrevealedFacts}
          />

          <section className="sideSection">
            <h2>{uiLanguage === 'english' ? 'Avatar Motion' : 'Avatar 動作'}</h2>
            <p className="motionCue">{motionPrompt(uiLanguage, motionCue)}</p>
            {avatarBlendshapeDebug && (
              <div className="realismBox" aria-label="Blendshape debug">
                <h3>Blendshape Debug</h3>
                <div className="avatarDirectiveGrid">
                  <DirectiveItem label="ARKit 模型" value={avatarBlendshapeDebug.arkitAvailable ? 'on' : 'fallback'} />
                  <DirectiveItem label="ARKit targets" value={`${avatarBlendshapeDebug.arkitTargetCount}`} />
                  <DirectiveItem label="模型" value={avatarBlendshapeDebug.modelPath} />
                  <DirectiveItem label="表情 Profile" value={avatarBlendshapeDebug.activeExpressionProfile} />
                  <DirectiveItem
                    label="Viseme"
                    value={
                      avatarBlendshapeDebug.activeVisemeChar
                        ? `${avatarBlendshapeDebug.activeViseme} (${avatarBlendshapeDebug.activeVisemeChar})`
                        : avatarBlendshapeDebug.activeViseme
                    }
                  />
                  <DirectiveItem label="嘴部權重" value={`${Math.round(avatarBlendshapeDebug.mouthWeight * 100)}%`} />
                  <DirectiveItem label="眉部權重" value={`${Math.round(avatarBlendshapeDebug.browWeight * 100)}%`} />
                  <DirectiveItem label="眼部權重" value={`${Math.round(avatarBlendshapeDebug.eyeWeight * 100)}%`} />
                </div>
              </div>
            )}
            {avatarMotionDebug && (
              <div className="realismBox" aria-label="Avatar Motion Lab">
                <h3>Avatar Motion Lab</h3>
                <div className="avatarDirectiveGrid">
                  <DirectiveItem label="語言" value={avatarMotionDebug.motionLanguage} />
                  <DirectiveItem label="Script" value={avatarMotionDebug.activeScriptId} />
                  <DirectiveItem label="Variant" value={avatarMotionDebug.activeVariant} />
                  <DirectiveItem label="Validation" value={avatarMotionDebug.validationStatus} />
                  <DirectiveItem label="Keyframes" value={`${avatarMotionDebug.keyframeCount}`} />
                  <DirectiveItem label="Duration" value={`${avatarMotionDebug.durationMs}ms`} />
                  <DirectiveItem label="Family" value={avatarMotionDebug.reactionFamily} />
                  <DirectiveItem label="Idle Mix" value={avatarMotionDebug.idleMixOnly ? 'on' : 'off'} />
                  <DirectiveItem label="Idle Accent" value={avatarMotionDebug.idleAccentFamily} />
                  <DirectiveItem label="Reaction" value={`${Math.round(avatarMotionDebug.reactionWeight * 100)}%`} />
                  <DirectiveItem label="Bridge" value={`${Math.round(avatarMotionDebug.bridgeProgress * 100)}%`} />
                  <DirectiveItem label="坐姿安全" value={avatarMotionDebug.seatedSafety} />
                </div>
                {avatarMotionDebug.validationIssues.length > 0 && (
                  <TagRow label="Validation issues" values={avatarMotionDebug.validationIssues.slice(0, 4)} />
                )}
                <TagRow label="最近動作" values={avatarMotionDebug.recentMotionHistory} />
              </div>
            )}
            {realismAssessment && (
              <div className="realismBox" aria-label="被試真實度評估">
                <h3>被試真實度</h3>
                <div className="avatarDirectiveGrid">
                  <DirectiveItem label="整體" value={`${realismAssessment.realismScore.toFixed(1)}/10`} />
                  <DirectiveItem label="連續性" value={`${realismAssessment.consistencyScore.toFixed(1)}/10`} />
                  <DirectiveItem label="透露適配" value={`${realismAssessment.disclosureFitScore.toFixed(1)}/10`} />
                  <DirectiveItem label={uiLanguage === 'english' ? 'Language naturalness' : '語言自然度'} value={`${realismAssessment.languageNaturalnessScore.toFixed(1)}/10`} />
                </div>
                {realismAssessment.repairApplied && (
                  <p className="overrideNote">已校準：{realismAssessment.repairReason ?? '回應真實度不足'}</p>
                )}
                <div className="basisSignals">
                  {realismAssessment.matchedRealismAnchors.map((anchor) => (
                    <span key={anchor}>{anchor}</span>
                  ))}
                </div>
              </div>
            )}
            {avatarDirective ? (
              <>
                <div className="avatarDirectiveGrid" aria-label="Avatar 表演指令">
                  <DirectiveItem label="情緒" value={avatarDirective.affect} />
                  <DirectiveItem label="動作" value={avatarDirective.motionCue} />
                  <DirectiveItem label="表情" value={avatarDirective.expressionPreset ?? avatarDirective.emotionCue} />
                  <DirectiveItem label="強度" value={`${Math.round((avatarDirective.intensity ?? 1) * 100)}%`} />
                  <DirectiveItem label="過渡" value={`${avatarDirective.transitionMs ?? 700}ms`} />
                  <DirectiveItem label="保持" value={`${avatarDirective.holdMs ?? 2500}ms`} />
                  <DirectiveItem label="優先級" value={avatarDirective.priority ?? 'reaction'} />
                </div>
                {avatarDirective.performancePlan && (
                  <div className="avatarDirectiveGrid" aria-label="Avatar VRMA performance plan">
                    <DirectiveItem label="Idle Clip" value={avatarDirective.performancePlan.baselineIdleClipId} />
                    <DirectiveItem label="基準 Clip" value={avatarDirective.performancePlan.baselineClipId} />
                    <DirectiveItem label="反應 Clip" value={avatarDirective.performancePlan.reactionClipId ?? 'procedural'} />
                    <DirectiveItem label="Reaction ID" value={avatarDirective.performancePlan.reactionInstanceId} />
                    <DirectiveItem label="反應時間" value={`${avatarDirective.performancePlan.reactionDurationMs}ms`} />
                    <DirectiveItem label="釋放時間" value={`${avatarDirective.performancePlan.releaseMs}ms`} />
                    <DirectiveItem label="Bridge" value={`${avatarDirective.performancePlan.returnBridgeMs ?? 700}ms`} />
                    <DirectiveItem label="Family" value={avatarDirective.performancePlan.reactionFamily ?? 'soft_engagement'} />
                    <DirectiveItem label="Variant" value={avatarDirective.performancePlan.variantPolicy ?? 'soft_random'} />
                    <DirectiveItem label="Mask" value={avatarDirective.performancePlan.playbackMask} />
                    <DirectiveItem label="來源" value={avatarDirective.performancePlan.clipSource} />
                    <DirectiveItem label="坐姿鎖定" value={avatarDirective.performancePlan.seatedRuntime ? 'on' : 'off'} />
                    <DirectiveItem label="Fallback" value={avatarDirective.performancePlan.fallbackUsed ? 'yes' : 'no'} />
                    <DirectiveItem
                      label="候選 Clips"
                      value={(avatarDirective.performancePlan.preferredClipIds ?? []).slice(0, 3).join(', ') || 'auto'}
                    />
                  </div>
                )}
                <DirectiveBasis
                  basis={avatarDirective.basis ?? []}
                  overriddenFromModel={avatarDirective.overriddenFromModel}
                  voiceStyle={avatarDirective.voiceStyle}
                />
              </>
            ) : (
              <p className="mutedText">{uiLanguage === 'english' ? 'After the client responds, ADK avatar directives will appear here.' : '服務對象回應後，這裡會顯示 ADK 輸出的表演指令。'}</p>
            )}
            {safetyFlags.length > 0 && (
              <div className="safetyFlagRow">
                {safetyFlags.map((flag) => (
                  <span key={flag}>{flag}</span>
                ))}
              </div>
            )}
            <label className="fileDrop compactDrop">
              上載 `.vrma`
              <input
                accept=".vrma"
                type="file"
                onChange={(event) => onVrmaFile(event.target.files?.[0] ?? null)}
              />
            </label>
            <p className="statusText">{statusMessage}</p>
          </section>
        </>
      )}
      {postSessionReport && isReportDialogOpen && (
        <div className="reportDialogOverlay" role="presentation" onMouseDown={() => setIsReportDialogOpen(false)}>
          <section
            aria-labelledby="post-session-report-title"
            aria-modal="true"
            className="reportDialog"
            role="dialog"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="reportDialogHeader">
              <div>
                <h2 id="post-session-report-title">{t(uiLanguage, 'fullReport')}</h2>
                <p>{t(uiLanguage, 'fullReportSubtitle')}</p>
              </div>
              <button aria-label={t(uiLanguage, 'closeReport')} className="iconButton" type="button" onClick={() => setIsReportDialogOpen(false)}>
                <X size={18} />
              </button>
            </header>
            <PostSessionReportView report={postSessionReport} detailed={isInstructor} uiLanguage={uiLanguage} />
          </section>
        </div>
      )}
    </aside>
  );
}

function observableStateLabel(
  caseProfile: CaseProfile,
  avatarDirective: ClientResponse['avatarDirective'] | null,
  uiLanguage: ResponseLanguage,
) {
  const affect = avatarDirective?.affect ?? caseProfile.psychologicalState.emotion;
  return observableLabel(uiLanguage, affect);
}

function observableStateHint(caseProfile: CaseProfile, motionCue: MotionCue, uiLanguage: ResponseLanguage) {
  if (motionCue !== 'neutral') return motionPrompt(uiLanguage, motionCue);
  if (caseProfile.hiddenFacts.some((fact) => fact.disclosed)) {
    return t(uiLanguage, 'observableWithFacts');
  }
  return t(uiLanguage, 'observableNoFacts');
}

function PostSessionReportView({
  report,
  detailed,
  uiLanguage,
}: {
  report: PostSessionSupervisorReport;
  detailed: boolean;
  uiLanguage: ResponseLanguage;
}) {
  return (
    <div className="postSessionReport">
      <div className="reportBlock">
        <h3>{t(uiLanguage, 'overallPerformance')}</h3>
        <p>{report.overallSummary}</p>
      </div>
      {!report.hkPcfAssessment && (
        <RadarScoreChart
          labels={competencyLabels}
          scores={report.competencyScores}
          title={uiLanguage === 'english' ? 'Supervision competency radar' : '督導能力雷達圖'}
        />
      )}
      <div className="scoreGrid">
        {Object.entries(report.competencyScores).map(([label, value]) => (
          <Metric key={label} label={competencyLabel(label, uiLanguage)} value={value} max={10} />
        ))}
      </div>
      {report.hkPcfAssessment && <HkPcfAssessmentView assessment={report.hkPcfAssessment} detailed={detailed} uiLanguage={uiLanguage} />}
      <TurningPointList items={report.processReview.turningPoints} detailed={detailed} uiLanguage={uiLanguage} />
      <FeedbackList title={t(uiLanguage, 'effectiveMoments')} items={report.processReview.effectiveMoments} />
      <FeedbackList title={t(uiLanguage, 'missedOpportunities')} items={report.processReview.missedOpportunities} />
      <FeedbackList title={t(uiLanguage, 'caseFramework')} items={report.caseSpecificFeedback.frameworkUsed} />
      <FeedbackList title={t(uiLanguage, 'objectivesMet')} items={report.caseSpecificFeedback.learningObjectivesMet} />
      <FeedbackList title={t(uiLanguage, 'objectivesNotMet')} items={report.caseSpecificFeedback.learningObjectivesNotMet} />
      <FeedbackList title={t(uiLanguage, 'practiceGoals')} items={report.suggestedPracticeGoals} />
    </div>
  );
}

function HkPcfAssessmentView({
  assessment,
  detailed,
  uiLanguage,
}: {
  assessment: NonNullable<PostSessionSupervisorReport['hkPcfAssessment']>;
  detailed: boolean;
  uiLanguage: ResponseLanguage;
}) {
  return (
    <div className="hkPcfBlock">
      <div className="reportBlock">
        <h3>{t(uiLanguage, 'hkPcf')}</h3>
        <p>{assessment.frameworkLabel}</p>
        <p className="disclaimerText">{assessment.disclaimer}</p>
      </div>
      <RadarScoreChart labels={hkPcfLabelsFor(uiLanguage)} scores={assessment.scores} title={t(uiLanguage, 'hkPcfRadar')} />
      <div className="scoreGrid">
        {Object.entries(assessment.scores).map(([label, value]) => (
          <Metric key={label} label={hkPcfLabel(label, uiLanguage)} value={value} max={10} />
        ))}
      </div>
      <FeedbackList title={t(uiLanguage, 'strengthEvidence')} items={assessment.evidence.strengths} />
      <FeedbackList title={t(uiLanguage, 'concernEvidence')} items={assessment.evidence.concerns} />
      <FeedbackList title={t(uiLanguage, 'turningPoints')} items={assessment.evidence.turningPoints} />
      <FeedbackList title={t(uiLanguage, 'missedOpportunities')} items={assessment.evidence.missedOpportunities} />
      <FeedbackList title={t(uiLanguage, 'practiceRecommendations')} items={assessment.practiceRecommendations} />
      {assessment.personInEnvironmentAssessment && (
        <div className="reportBlock">
          <h3>{t(uiLanguage, 'pieAssessment')}</h3>
          <p>{assessment.personInEnvironmentAssessment.summary}</p>
        </div>
      )}
      {assessment.microMesoMacroCoverage && (
        <div className="scoreGrid">
          <Metric label="Micro 微觀" value={assessment.microMesoMacroCoverage.micro.score} max={10} />
          <Metric label="Meso 中觀" value={assessment.microMesoMacroCoverage.meso.score} max={10} />
          <Metric label="Macro 宏觀" value={assessment.microMesoMacroCoverage.macro.score} max={10} />
        </div>
      )}
      {detailed && (
        <>
          <FeedbackList title={t(uiLanguage, 'frameworkBasis')} items={assessment.frameworkBasis} />
          <div className="reportBlock">
            <h3>{t(uiLanguage, 'instructorNote')}</h3>
            <p>{t(uiLanguage, 'instructorNoteBody')}</p>
          </div>
        </>
      )}
    </div>
  );
}

function TurningPointList({
  items,
  detailed,
  uiLanguage,
}: {
  items: PostSessionSupervisorReport['processReview']['turningPoints'];
  detailed: boolean;
  uiLanguage: ResponseLanguage;
}) {
  if (!items.length) return null;
  return (
    <div className="feedbackList">
      <h3>{t(uiLanguage, 'turningPointReview')}</h3>
      {items.map((item) => (
        <div className="turningPoint" key={`${item.turnId}-${item.whatHappened}`}>
          <strong>{item.turnId}</strong>
          <p>{item.whatHappened}</p>
          <p>{item.whyItMattered}</p>
          {detailed && item.betterAlternative && <p>{t(uiLanguage, 'alternativeMove')}：{item.betterAlternative}</p>}
        </div>
      ))}
    </div>
  );
}

function DebriefSection({
  caseProfile,
  evidenceSummary,
  postSessionReport,
  knownFacts,
  unrevealedFacts,
}: {
  caseProfile: CaseProfile;
  evidenceSummary: EvidenceSummary | null;
  postSessionReport: PostSessionSupervisorReport | null;
  knownFacts: CaseProfile['hiddenFacts'];
  unrevealedFacts: CaseProfile['hiddenFacts'];
}) {
  return (
    <section className="sideSection">
      <div className="sectionTitle">
        <FileText size={16} />
        <h2>個案回顧</h2>
      </div>
      <div className="debriefGrid">
        <DirectiveItem label="已探索" value={`${knownFacts.length}`} />
        <DirectiveItem label="未探索" value={`${unrevealedFacts.length}`} />
        <DirectiveItem
          label="整體準備度"
          value={postSessionReport ? `${postSessionReport.competencyScores.engagement.toFixed(1)}/10` : '未評估'}
        />
        <DirectiveItem label="證據卡" value={`${evidenceSummary?.cardCount ?? 0}`} />
      </div>
      <TagRow label="已探索資訊" values={knownFacts.map((fact) => fact.label)} />
      <TagRow label="仍未探索" values={unrevealedFacts.map((fact) => fact.label)} />
      <TagRow label="支撐來源" values={Object.keys(evidenceSummary?.sources ?? {})} />
      <p className="mutedText">完整事件線、關係圖和證據摘要在督導/研究者模式用於事後回顧，不應在正式訓練中提前展示。</p>
      <p className="mutedText">個案來源：{caseProfile.source}</p>
    </section>
  );
}

function DirectiveItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function DirectiveBasis({
  basis,
  overriddenFromModel,
  voiceStyle,
}: {
  basis: NonNullable<ClientResponse['avatarDirective']>['basis'];
  overriddenFromModel: NonNullable<ClientResponse['avatarDirective']>['overriddenFromModel'];
  voiceStyle: string;
}) {
  if (!basis?.length) return null;
  return (
    <div className="avatarBasis">
      <h3>表演依據</h3>
      <p className="mutedText">聲線：{voiceStyle}</p>
      {overriddenFromModel && (
        <p className="overrideNote">
          已覆蓋模型建議：
          {overriddenFromModel.affect ? ` 情緒 ${overriddenFromModel.affect}` : ''}
          {overriddenFromModel.motionCue ? ` 動作 ${overriddenFromModel.motionCue}` : ''}
        </p>
      )}
      {basis.map((item) => (
        <article className="basisItem" key={item.ruleId}>
          <strong>{item.label}</strong>
          <span>{item.ruleId}</span>
          <p>{item.rationale}</p>
          <div className="basisSignals">
            {item.signals.map((signal) => (
              <span key={signal}>{signal}</span>
            ))}
          </div>
        </article>
      ))}
    </div>
  );
}

function RadarScoreChart({
  labels,
  scores,
  title,
}: {
  labels: Record<string, string>;
  scores: Record<string, number>;
  title: string;
}) {
  const entries = Object.entries(scores).filter(([, value]) => Number.isFinite(value));
  if (entries.length < 3) return null;
  const size = 280;
  const center = size / 2;
  const radius = 86;
  const labelRadius = 116;
  const rings = [2, 4, 6, 8, 10];
  const pointFor = (index: number, value: number, baseRadius = radius) => {
    const angle = -Math.PI / 2 + (index / entries.length) * Math.PI * 2;
    const distance = baseRadius * (Math.min(10, Math.max(0, value)) / 10);
    return {
      x: center + Math.cos(angle) * distance,
      y: center + Math.sin(angle) * distance,
    };
  };
  const ringPoints = (value: number) => entries.map((_, index) => pointFor(index, value)).map(pointString).join(' ');
  const scorePoints = entries.map(([, value], index) => pointFor(index, value)).map(pointString).join(' ');
  return (
    <div className="radarChartBlock">
      <h3>{title}</h3>
      <div className="radarChartFrame">
        <svg aria-label={title} className="radarChart" role="img" viewBox={`0 0 ${size} ${size}`}>
          <title>{title}</title>
          {rings.map((ring) => (
            <polygon className="radarRing" key={ring} points={ringPoints(ring)} />
          ))}
          {entries.map(([key], index) => {
            const outer = pointFor(index, 10);
            const label = pointFor(index, 10, labelRadius);
            return (
              <g key={key}>
                <line className="radarAxis" x1={center} x2={outer.x} y1={center} y2={outer.y} />
                <text className="radarLabel" textAnchor={label.x < center - 8 ? 'end' : label.x > center + 8 ? 'start' : 'middle'} x={label.x} y={label.y}>
                  {shortRadarLabel(labels[key] ?? key)}
                </text>
              </g>
            );
          })}
          <polygon className="radarArea" points={scorePoints} />
          <polyline className="radarLine" points={`${scorePoints} ${scorePoints.split(' ')[0]}`} />
          {entries.map(([key, value], index) => {
            const point = pointFor(index, value);
            return <circle className="radarPoint" cx={point.x} cy={point.y} key={key} r="3.2" />;
          })}
        </svg>
        <div className="radarLegend">
          {entries.map(([key, value]) => (
            <span key={key}>
              {labels[key] ?? key} <strong>{value.toFixed(1)}</strong>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function pointString(point: { x: number; y: number }) {
  return `${point.x.toFixed(1)},${point.y.toFixed(1)}`;
}

function shortRadarLabel(label: string) {
  return label
    .replace('人在情境與香港脈絡', '人在情境')
    .replace('倫理、保密與界線', '倫理界線')
    .replace('差異、反歧視與文化敏感', '差異敏感')
    .replace('風險、安全與保護', '風險安全')
    .replace('專業反思與督導運用', '專業反思')
    .replace('建立關係與投入', '建立關係')
    .replace('資料收集與評估', '資料評估')
    .replace('自決與知情選擇', '自決選擇')
    .replace('介入計劃與轉介', '計劃轉介');
}

function Metric({ label, value, max }: { label: string; value: number; max: number }) {
  const percentage = Math.min(100, Math.max(0, (value / max) * 100));
  return (
    <div className="metric">
      <div>
        <span>{label}</span>
        <strong>{value.toFixed(1)}</strong>
      </div>
      <div className="meter">
        <span style={{ width: `${percentage}%` }} />
      </div>
    </div>
  );
}

function FeedbackList({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="feedbackList">
      <h3>{title}</h3>
      {items.map((item) => (
        <p key={item}>{item}</p>
      ))}
    </div>
  );
}

const competencyLabels: Record<string, string> = {
  engagement: '關係建立',
  assessment: '評估能力',
  empathyAndAttunement: '同理調頻',
  personInEnvironment: '人在環境中',
  strengthsPerspective: '優勢視角',
  riskAndSafety: '風險與安全',
  ethicsAndBoundaries: '倫理與界線',
  culturalHumility: '文化謙遜',
  nextStepPlanning: '下一步計劃',
};

const competencyLabelsEn: Record<string, string> = {
  engagement: 'Engagement',
  assessment: 'Assessment',
  empathyAndAttunement: 'Empathy',
  personInEnvironment: 'PIE',
  strengthsPerspective: 'Strengths',
  riskAndSafety: 'Risk and safety',
  ethicsAndBoundaries: 'Ethics',
  culturalHumility: 'Cultural humility',
  nextStepPlanning: 'Next steps',
};

const hkPcfLabels: Record<string, string> = {
  engagementAndRelationship: '建立關係與投入',
  assessmentAndInformationGathering: '資料收集與評估',
  personInEnvironmentAndHongKongContext: '人在情境與香港脈絡',
  ethicsConfidentialityAndBoundaries: '倫理、保密與界線',
  selfDeterminationAndInformedChoice: '自決與知情選擇',
  diversityAntiDiscriminationAndCulturalSensitivity: '差異、反歧視與文化敏感',
  riskSafetyAndSafeguarding: '風險、安全與保護',
  interventionPlanningAndReferral: '介入計劃與轉介',
  professionalReflectionAndUseOfSupervision: '專業反思與督導運用',
};

const hkPcfLabelsEn: Record<string, string> = {
  engagementAndRelationship: 'Engagement and relationship',
  assessmentAndInformationGathering: 'Assessment and information gathering',
  personInEnvironmentAndHongKongContext: 'Person-in-environment and Hong Kong context',
  ethicsConfidentialityAndBoundaries: 'Ethics, confidentiality, and boundaries',
  selfDeterminationAndInformedChoice: 'Self-determination and informed choice',
  diversityAntiDiscriminationAndCulturalSensitivity: 'Diversity, anti-discrimination, and cultural sensitivity',
  riskSafetyAndSafeguarding: 'Risk, safety, and safeguarding',
  interventionPlanningAndReferral: 'Intervention planning and referral',
  professionalReflectionAndUseOfSupervision: 'Professional reflection and use of supervision',
};

function competencyLabel(key: string, language: ResponseLanguage) {
  return (language === 'english' ? competencyLabelsEn : competencyLabels)[key] ?? key;
}

function hkPcfLabelsFor(language: ResponseLanguage) {
  return language === 'english' ? hkPcfLabelsEn : hkPcfLabels;
}

function hkPcfLabel(key: string, language: ResponseLanguage) {
  return hkPcfLabelsFor(language)[key] ?? key;
}

const simulationMethodOptions: Array<{ value: SimulationMethod; label: string; description: string }> = [
  {
    value: 'social_work_default',
    label: 'Social Work Default',
    description: '現有社工訓練主流程，保持預設行為和速度。',
  },
  {
    value: 'adaptive_vp',
    label: 'Adaptive-VP',
    description: '更強調學生社工話術如何即時改變阻抗、開放度和透露深度。',
  },
  {
    value: 'consistent_mi',
    label: 'Consistent MI',
    description: '更強調動機式訪談中的阻抗、矛盾和 change talk 連續轉換。',
  },
  {
    value: 'patient_psi_context',
    label: 'Patient-PSI Context',
    description: '更強調個案內在信念、自述 grounding 和 context consistency。',
  },
  {
    value: 'roleplay_doh',
    label: 'Roleplay DOH',
    description: '更強調角色扮演自然度，避免教科書式或治療師式回答。',
  },
  {
    value: 'annaagent_memory',
    label: 'AnnaAgent Memory',
    description: '更強調 session 記憶、關係破裂/修復和前文一致性。',
  },
];

function TagRow({ label, values }: { label: string; values: string[] }) {
  if (!values.length) return null;
  return (
    <div className="tagRow">
      <strong>{label}</strong>
      <div>
        {values.map((value) => (
          <span key={value}>{value}</span>
        ))}
      </div>
    </div>
  );
}
