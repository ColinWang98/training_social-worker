import { useEffect, useState } from 'react';
import { Activity, CheckCircle2, Eye, EyeOff, FileText, Network, ShieldAlert, Sparkles } from 'lucide-react';
import { getKnownFacts, getRecentEvents, getUnrevealedFacts } from '../lib/caseEngine';
import {
  CaseProfile,
  ClientResponse,
  EvidenceSummary,
  MotionCue,
  PostSessionSupervisorReport,
  RetrievalOptions,
  SimulationMethod,
  TrainingViewMode,
} from '../lib/interviewTypes';
import { motionCuePrompts } from '../lib/avatarConfig';
import type { AvatarBlendshapeDebug } from '../App';

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
  safetyFlags: string[];
  safetyHint: string | null;
  postSessionReport: PostSessionSupervisorReport | null;
  isFinalReviewPending: boolean;
  canEndSession: boolean;
  motionCue: MotionCue;
  statusMessage: string;
  avatarBlendshapeDebug: AvatarBlendshapeDebug | null;
  onCaseChange: (caseId: string) => void;
  onEndSession: () => void;
  onSimulationMethodChange: (method: SimulationMethod) => void;
  onRetrievalOptionsChange: (options: RetrievalOptions) => void;
  onVrmaFile: (file: File | null) => void;
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
  safetyFlags,
  safetyHint,
  postSessionReport,
  isFinalReviewPending,
  canEndSession,
  motionCue,
  statusMessage,
  avatarBlendshapeDebug,
  onCaseChange,
  onEndSession,
  onSimulationMethodChange,
  onRetrievalOptionsChange,
  onVrmaFile,
}: CasePanelProps) {
  const state = caseProfile.psychologicalState;
  const knownFacts = getKnownFacts(caseProfile);
  const unrevealedFacts = getUnrevealedFacts(caseProfile);
  const [viewMode, setViewMode] = useState<TrainingViewMode>('trainee');
  const isInstructor = viewMode === 'instructor';

  useEffect(() => {
    setViewMode('trainee');
  }, [caseProfile.id]);

  return (
    <aside className="casePanel" aria-label="個案狀態及督導">
      <section className="sideSection modeSection">
        <div className="sectionTitle">
          {isInstructor ? <Eye size={16} /> : <EyeOff size={16} />}
          <h2>顯示模式</h2>
        </div>
        <div className="modeSwitch" role="group" aria-label="訓練顯示模式">
          <button
            className={viewMode === 'trainee' ? 'active' : ''}
            type="button"
            onClick={() => setViewMode('trainee')}
          >
            學生社工
          </button>
          <button
            className={viewMode === 'instructor' ? 'active' : ''}
            type="button"
            onClick={() => setViewMode('instructor')}
          >
            督導/研究者
          </button>
        </div>
        <p className="mutedText">
          {isInstructor
            ? '完整個案、證據與調試資訊只供督導、研究者或本地測試使用。'
            : '訓練視圖只顯示轉介摘要和訪談中自然出現的資訊。'}
        </p>
      </section>

      <section className="sideSection">
        <div className="sectionTitle">
          <Activity size={16} />
          <h2>個案狀態</h2>
        </div>
        <label className="caseSelector">
          <span>問題類型</span>
          <select value={caseProfile.id} onChange={(event) => onCaseChange(event.target.value)}>
            {caseProfiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.issueLabel}
              </option>
            ))}
          </select>
        </label>
        <h3 className="localizedTitle">{caseProfile.localizedTitle}</h3>
        <p className="caseIntro">{caseProfile.client.presentingContext}</p>
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
            <span>可觀察狀態</span>
            <strong>{observableStateLabel(caseProfile, avatarDirective)}</strong>
            <p>{observableStateHint(caseProfile, motionCue)}</p>
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
          <h2>督導評估</h2>
        </div>
        <p className="mutedText">
          訪談進行中不顯示完整督導回饋；系統只在背景記錄過程，完整評估會於結束訪談後生成。
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
          disabled={!canEndSession || isFinalReviewPending}
          onClick={onEndSession}
        >
          <CheckCircle2 size={16} />
          {isFinalReviewPending ? '正在生成督導報告' : postSessionReport ? '督導報告已生成' : '結束訪談並生成報告'}
        </button>
        {postSessionReport ? (
          <>
            <PostSessionReportView report={postSessionReport} detailed={isInstructor} />
          </>
        ) : (
          <p className="mutedText">完成練習後按「結束訪談」，系統會基於整場 transcript、風險探索、透露節奏和關係變化生成報告。</p>
        )}
      </section>

      <section className="sideSection">
        <h2>已透露資訊</h2>
        {isInstructor && (
          <p className="mutedText">
            已知 {knownFacts.length} / 未透露 {unrevealedFacts.length}
          </p>
        )}
        {!isInstructor && knownFacts.length === 0 && (
          <p className="mutedText">暫時未在訪談中透露具體背景。</p>
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
            <h2>Avatar 動作</h2>
            <p className="motionCue">{motionCuePrompts[motionCue]}</p>
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
            {realismAssessment && (
              <div className="realismBox" aria-label="被試真實度評估">
                <h3>被試真實度</h3>
                <div className="avatarDirectiveGrid">
                  <DirectiveItem label="整體" value={`${realismAssessment.realismScore.toFixed(1)}/10`} />
                  <DirectiveItem label="連續性" value={`${realismAssessment.consistencyScore.toFixed(1)}/10`} />
                  <DirectiveItem label="透露適配" value={`${realismAssessment.disclosureFitScore.toFixed(1)}/10`} />
                  <DirectiveItem label="粵語自然度" value={`${realismAssessment.languageNaturalnessScore.toFixed(1)}/10`} />
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
              <p className="mutedText">服務對象回應後，這裡會顯示 ADK 輸出的表演指令。</p>
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
    </aside>
  );
}

function observableStateLabel(
  caseProfile: CaseProfile,
  avatarDirective: ClientResponse['avatarDirective'] | null,
) {
  const affect = avatarDirective?.affect ?? caseProfile.psychologicalState.emotion;
  if (affect.includes('defensive')) return '防衛、保持距離';
  if (affect.includes('withdrawn')) return '退縮、少說話';
  if (affect.includes('anxious')) return '緊張、不安';
  if (affect.includes('ashamed')) return '羞恥、低頭迴避';
  if (affect.includes('irritated')) return '被冒犯、抗拒';
  if (affect.includes('sad')) return '低落、無力';
  if (affect.includes('reflective')) return '稍為願意思考';
  return '觀望、未完全投入';
}

function observableStateHint(caseProfile: CaseProfile, motionCue: MotionCue) {
  if (motionCue !== 'neutral') return motionCuePrompts[motionCue];
  if (caseProfile.hiddenFacts.some((fact) => fact.disclosed)) {
    return '已開始透露部分背景，但仍需要以開放式和同理方式跟進。';
  }
  return '目前只能根據轉介摘要和對話反應探索。';
}

function PostSessionReportView({ report, detailed }: { report: PostSessionSupervisorReport; detailed: boolean }) {
  return (
    <div className="postSessionReport">
      <div className="reportBlock">
        <h3>總體表現</h3>
        <p>{report.overallSummary}</p>
      </div>
      <div className="scoreGrid">
        {Object.entries(report.competencyScores).map(([label, value]) => (
          <Metric key={label} label={competencyLabels[label] ?? label} value={value} max={10} />
        ))}
      </div>
      <TurningPointList items={report.processReview.turningPoints} detailed={detailed} />
      <FeedbackList title="有效做法" items={report.processReview.effectiveMoments} />
      <FeedbackList title="錯過機會" items={report.processReview.missedOpportunities} />
      <FeedbackList title="個案特定框架" items={report.caseSpecificFeedback.frameworkUsed} />
      <FeedbackList title="已達成學習目標" items={report.caseSpecificFeedback.learningObjectivesMet} />
      <FeedbackList title="仍需練習目標" items={report.caseSpecificFeedback.learningObjectivesNotMet} />
      <FeedbackList title="下一次練習建議" items={report.suggestedPracticeGoals} />
    </div>
  );
}

function TurningPointList({
  items,
  detailed,
}: {
  items: PostSessionSupervisorReport['processReview']['turningPoints'];
  detailed: boolean;
}) {
  if (!items.length) return null;
  return (
    <div className="feedbackList">
      <h3>關鍵片段回顧</h3>
      {items.map((item) => (
        <div className="turningPoint" key={`${item.turnId}-${item.whatHappened}`}>
          <strong>{item.turnId}</strong>
          <p>{item.whatHappened}</p>
          <p>{item.whyItMattered}</p>
          {detailed && item.betterAlternative && <p>可替代做法：{item.betterAlternative}</p>}
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
