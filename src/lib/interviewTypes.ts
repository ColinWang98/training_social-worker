export type AffectLabel =
  | 'neutral'
  | 'defensive'
  | 'ashamed'
  | 'anxious'
  | 'reflective'
  | 'withdrawn'
  | 'irritated'
  | 'sad';

export type MotionCue =
  | 'neutral'
  | 'look_down'
  | 'avoid_eye_contact'
  | 'rub_hands'
  | 'lean_back'
  | 'slow_nod';

export type CaseType =
  | 'alcohol_misuse'
  | 'student_depression_bullying'
  | 'anxiety_family_invalidated'
  | 'substance_recovery_meth'
  | 'trauma_sleep_low_self_worth';

export type SimulationMethod =
  | 'social_work_default'
  | 'adaptive_vp'
  | 'consistent_mi'
  | 'patient_psi_context'
  | 'roleplay_doh'
  | 'annaagent_memory';

export type ResistanceLevel = 'none' | 'mild' | 'moderate' | 'high';
export type AvatarDirectivePriority = 'safety' | 'reaction' | 'speaking' | 'idle';
export type TrainingViewMode = 'trainee' | 'instructor';
export type AvatarGazePattern = 'camera_soft' | 'avoidant' | 'downward' | 'scanning' | 'guarded';

export type EvidenceSource =
  | 'annomi'
  | 'student_mh_en'
  | 'amod'
  | 'therapytalk'
  | 'addiction_sft'
  | 'esconv'
  | 'counsel_chat'
  | 'multilingual_therapy'
  | 'empathetic_dialogues'
  | 'reddit_mental_health_private';

export type EvidenceCard = {
  id: string;
  source: EvidenceSource;
  clientGroup: 'student' | 'adult' | 'substance_use' | 'depression' | 'anxiety' | 'trauma';
  issueTags: string[];
  clientUtterance: string;
  workerMove?: string;
  affect: string;
  riskSignals: string[];
  resistanceType?: 'denial' | 'minimizing' | 'shame' | 'avoidance' | 'anger' | 'ambivalence';
  changeTalk?: string[];
  disclosureDepth: 1 | 2 | 3 | 4;
  quality: 'approved' | 'review' | 'reject';
  licenseNote: string;
  provenanceNote?: string;
};

export type EvidenceSummary = {
  sources: Partial<Record<EvidenceSource, number>>;
  issueTags: string[];
  riskSignals: string[];
  cardCount: number;
  retrievalDebug?: {
    backend?: string;
    retrievalMode?: string;
    embeddingStatus?: string;
    embeddingModel?: string;
    ftsCandidateCount?: number;
    metadataCandidateCount?: number;
    candidateCount?: number;
    embeddedCandidateCount?: number;
    cosineRange?: [number, number] | null;
    sourceDistribution?: Partial<Record<EvidenceSource, number>>;
  };
};

export type AvatarBehaviorBasis = {
  ruleId: string;
  label: string;
  sourceType: 'rule' | 'corpus' | 'supervisor' | 'safety' | 'realism_anchor';
  signals: string[];
  rationale: string;
};

export type AvatarPerformancePlan = {
  reactionInstanceId: string;
  baselineIdleClipId: string;
  baselineClipId: string;
  reactionClipId?: string;
  speechOverlayClipId?: string;
  clipSequence: string[];
  returnToClipId: string;
  clipSource: 'procedural' | 'vrma';
  playbackMask: 'upper_body';
  seatedRuntime: boolean;
  seatedSafety: 'forced_seated_lower_body';
  crossfadeMs: number;
  reactionDurationMs: number;
  releaseMs: number;
  motionScale: number;
  fallbackUsed?: boolean;
  reactionFamily?: 'defensive' | 'withdrawn' | 'anxious' | 'ashamed' | 'reflective' | 'risk' | 'soft_engagement';
  preferredClipIds?: string[];
  excludedRecentClipIds?: string[];
  variantPolicy?: 'avoid_recent' | 'soft_random';
  returnBridgeMs?: number;
  attackMs?: number;
  releaseCurve?: 'soft' | 'guarded' | 'low_energy';
};

export type ClientRealismAssessment = {
  realismScore: number;
  consistencyScore: number;
  disclosureFitScore: number;
  languageNaturalnessScore: number;
  riskSignalStrength?: number;
  overDisclosureRisk: boolean;
  underReactionRisk: boolean;
  repeatedResponseRisk?: boolean;
  matchedRealismAnchors: string[];
  repairApplied?: boolean;
  repairReason?: string;
};

export type SimulationStrategySnapshot = {
  simulationMethod: SimulationMethod;
  label: string;
  promptFocus: string[];
  responseConstraints: string[];
  retrievalBoostSources: EvidenceSource[];
  retrievalBoostTags: string[];
  evaluatorFocus: string[];
};

export type EvaluationReport = {
  schemaValidity: number;
  clientRealism: number;
  contextConsistency: number;
  disclosurePacing: number;
  sessionContinuity: number;
  riskGating: number;
  socialWorkInterviewQuality: number;
  avatarAlignment: number;
  corpusGrounding: number;
  overallReadiness: number;
};

export type RetrievalOptions = {
  embeddingEnabled?: boolean;
};

export type GroundingProfile = {
  selfReportGrounding: Record<string, unknown>;
  lifeHistory: string;
  familySchoolWorkContext: string;
  relationshipHistory: string;
  valuesFearsShameTriggers: Record<string, unknown>;
  avoidancePatterns: string[];
  speechStyle: string;
  caseReflections: Record<string, string[]>;
  adaptationLog: Array<Record<string, unknown>>;
  sourceEvidenceSummary: EvidenceSummary;
};

export type StudentQuestionAnalysis = {
  openQuestion: boolean;
  reflectiveListening: boolean;
  judgmentalOrDirective: boolean;
  mockingOrDismissive?: boolean;
  riskExploration: boolean;
  prematureAdvice: boolean;
  apologyRepair?: boolean;
};

export type PsychologicalState = {
  emotion: string;
  distressLevel: number;
  stressLevel: number;
  selfEsteem: number;
  socialConnection: number;
  academicPressure: number;
  clientOpenness: number;
};

export type AvatarBaseline = {
  baselineMood: AffectLabel;
  restingCue: MotionCue;
  idleIntensity: number;
  gazePattern: AvatarGazePattern;
  postureLabel: string;
};

export type SocialWorkContextModel = {
  selfNarrative: string;
  coreBeliefs: string[];
  shameTriggers: string[];
  avoidancePatterns: string[];
  helpSeekingBeliefs: string[];
  relationshipExpectations: string[];
  stressResponseStyle: string;
  disclosureRules: string[];
};

export type LifeEvent = {
  type: string;
  description: string;
  impactScore: number;
  day: number;
  participants: string[];
};

export type Relationship = {
  person: string;
  role: string;
  closeness: number;
  trust: number;
  conflict: number;
};

export type HiddenFact = {
  id: string;
  label: string;
  content: string;
  disclosed: boolean;
};

export type CaseProfile = {
  id: string;
  caseType: CaseType;
  issueLabel: string;
  localizedTitle: string;
  issueTags: string[];
  simulatorStage: string;
  source: string;
  client: {
    displayName: string;
    age: number;
    pronouns: string;
    schoolStage: string;
    presentingContext: string;
  };
  persona: {
    background: string;
    currentStressors: string[];
    disclosureThresholds: {
      rapport: number;
      safety: number;
      directness: number;
    };
    speechStyleExamples: string[];
    resistancePatterns: string[];
    changeTalkSignals: string[];
  };
  socialWorkContextModel: SocialWorkContextModel;
  psychologicalState: PsychologicalState;
  avatarBaseline: AvatarBaseline;
  relationships: Relationship[];
  eventTimeline: LifeEvent[];
  hiddenFacts: HiddenFact[];
  riskProfile: {
    baselineRisk: string;
    protectiveFactors: string[];
    watchFor: string[];
  };
};

export type ScoreSnapshot = {
  rapport: number;
  empathy: number;
  openQuestion: number;
  reflectiveListening: number;
  riskAssessment: number;
  autonomySupport: number;
  strengthsPerspective: number;
  nextStepSafety: number;
};

export type InterviewTurn = {
  id: string;
  speaker: 'student' | 'client';
  text: string;
  timestamp: string;
  revealedFacts?: string[];
  scoreSnapshot?: Partial<ScoreSnapshot>;
};

export type ClientResponse = {
  clientText: string;
  simulationMethod?: SimulationMethod;
  affect: AffectLabel;
  riskSignals: string[];
  revealedFacts: string[];
  stateDelta: Partial<Record<keyof PsychologicalState, number>>;
  motionCue: MotionCue;
  resistanceLevel: ResistanceLevel;
  changeTalk?: string[];
  evidenceSummary?: EvidenceSummary;
  realismAssessment?: ClientRealismAssessment;
  adaptivePolicySnapshot?: {
    targetResistanceLevel: ResistanceLevel;
    targetOpennessDeltaRange: [number, number];
    allowedDisclosureDepth: 1 | 2 | 3 | 4;
    responseStyleConstraints: string[];
    requiredAffectHints: AffectLabel[];
    avatarBehaviorHints: MotionCue[];
  };
  simulationStrategySnapshot?: SimulationStrategySnapshot;
  sessionContinuitySnapshot?: {
    trustTrajectory: number[];
    ruptureEvents: string[];
    repairAttempts: string[];
    disclosedFactIds: string[];
    avoidedTopics: string[];
    recurringLanguagePatterns: string[];
    relationshipMemory: string;
    sessionReflection?: {
      trustState: string;
      clientViewOfStudent: string;
      avoidedTopics: string[];
      nextResponseTone: string;
    };
  };
  contextConsistencyAssessment?: {
    score: number;
    matchedBeliefs: string[];
    violatedBeliefs: string[];
    disclosureRuleNotes: string[];
  };
  agentTraceId?: string;
  safetyFlags?: string[];
  safetyHint?: string;
  avatarDirective?: {
    affect: AffectLabel;
    motionCue: MotionCue;
    baselineMood?: AffectLabel;
    gesture?: MotionCue;
    transitionMs?: number;
    holdMs?: number;
    priority?: AvatarDirectivePriority;
    ttsText: string;
    voiceStyle: string;
    emotionCue: string;
    expressionPreset?: string;
    expressionWeights?: Partial<Record<string, number>>;
    intensity?: number;
    performancePlan?: AvatarPerformancePlan;
    basis?: AvatarBehaviorBasis[];
    overriddenFromModel?: {
      affect?: string;
      motionCue?: string;
    };
  };
  supervisorReview?: SupervisorReview;
};

export type SupervisorReview = {
  scores: ScoreSnapshot;
  strengths: string[];
  missedOpportunities: string[];
  riskNotes: string[];
  suggestedNextQuestions: string[];
  clientOpennessChange: number;
  summary: string;
};

export type PostSessionSupervisorReport = {
  overallSummary: string;
  competencyScores: {
    engagement: number;
    assessment: number;
    empathyAndAttunement: number;
    personInEnvironment: number;
    strengthsPerspective: number;
    riskAndSafety: number;
    ethicsAndBoundaries: number;
    culturalHumility: number;
    nextStepPlanning: number;
  };
  processReview: {
    turningPoints: {
      turnId: string;
      whatHappened: string;
      whyItMattered: string;
      betterAlternative?: string;
    }[];
    effectiveMoments: string[];
    missedOpportunities: string[];
  };
  caseSpecificFeedback: {
    frameworkUsed: string[];
    learningObjectivesMet: string[];
    learningObjectivesNotMet: string[];
  };
  suggestedPracticeGoals: string[];
};
