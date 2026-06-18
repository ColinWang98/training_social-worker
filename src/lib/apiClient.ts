import {
  CaseProfile,
  ClientResponse,
  EvidenceCardListResponse,
  InterviewTurn,
  LipSyncTimeline,
  PostSessionSupervisorReport,
  ResponseLanguage,
  RetrievalOptions,
  SimulationMethod,
  SupervisorReview,
} from './interviewTypes';

type InterviewRequest = {
  caseProfile: CaseProfile;
  studentText: string;
  history: InterviewTurn[];
  sessionId?: string | null;
  simulationMethod?: SimulationMethod;
  retrievalOptions?: RetrievalOptions;
  responseLanguage?: ResponseLanguage;
};

type SupervisorRequest = {
  caseProfile: CaseProfile;
  history: InterviewTurn[];
  latestResponse: ClientResponse;
  sessionId?: string | null;
};

type SessionRequest = {
  caseProfile: CaseProfile;
  sessionId?: string | null;
};

type FinalReviewRequest = {
  caseProfile: CaseProfile;
  history: InterviewTurn[];
  sessionId?: string | null;
  responseLanguage?: ResponseLanguage;
};

type SessionResponse = {
  sessionId: string;
  caseId?: string;
  reset?: boolean;
};

export type EvidenceCardListRequest = {
  search?: string;
  source?: string;
  quality?: string;
  clientGroup?: string;
  affect?: string;
  tag?: string;
  limit?: number;
  offset?: number;
};

export type TtsRequest = {
  text: string;
  affect?: string;
  voiceStyle?: string;
  voice?: string;
  language?: ResponseLanguage;
};

export type TtsResponse = {
  mimeType: string;
  audioBase64: string;
  provider: string;
  voice: string;
  lipSync?: LipSyncTimeline;
};

export async function requestClientResponse(request: InterviewRequest): Promise<ClientResponse> {
  const data = await postJson('/api/interview-turn', request);
  if (!isClientResponse(data)) {
    throw new Error('Client response failed schema validation.');
  }
  return data;
}

export async function requestSupervisorReview(request: SupervisorRequest): Promise<SupervisorReview> {
  const data = await postJson('/api/supervisor-review', request);
  if (!isSupervisorReview(data)) {
    throw new Error('Supervisor response failed schema validation.');
  }
  return data;
}

export async function requestFinalReview(request: FinalReviewRequest): Promise<PostSessionSupervisorReport> {
  const data = await postJson('/api/session/final-review', request);
  if (!isPostSessionSupervisorReport(data)) {
    throw new Error('Post-session supervisor report failed schema validation.');
  }
  return data;
}

export async function startSession(request: SessionRequest): Promise<SessionResponse> {
  const data = await postJson('/api/session/start', request);
  if (!isSessionResponse(data)) {
    throw new Error('Session start failed schema validation.');
  }
  return data;
}

export async function resetSession(request: SessionRequest): Promise<SessionResponse> {
  const data = await postJson('/api/session/reset', request);
  if (!isSessionResponse(data)) {
    throw new Error('Session reset failed schema validation.');
  }
  return data;
}

export async function requestTtsAudio(request: TtsRequest): Promise<TtsResponse> {
  const data = await postJson('/api/tts', request);
  if (!isTtsResponse(data)) {
    throw new Error('TTS response failed schema validation.');
  }
  return data;
}

export async function listEvidenceCards(request: EvidenceCardListRequest): Promise<EvidenceCardListResponse> {
  const params = new URLSearchParams();
  Object.entries(request).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value));
    }
  });
  const response = await fetch(`/api/evidence-cards?${params.toString()}`);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error ?? `Request failed with ${response.status}`);
  }
  if (!isEvidenceCardListResponse(data)) {
    throw new Error('Evidence card list failed schema validation.');
  }
  return data;
}

async function postJson(path: string, body: unknown) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error ?? `Request failed with ${response.status}`);
  }
  return data;
}

function isClientResponse(value: unknown): value is ClientResponse {
  const response = value as ClientResponse;
  return (
    typeof response?.clientText === 'string' &&
    typeof response?.affect === 'string' &&
    Array.isArray(response.riskSignals) &&
    Array.isArray(response.revealedFacts) &&
    typeof response.resistanceLevel === 'string' &&
    typeof response.stateDelta === 'object' &&
    typeof response.motionCue === 'string'
  );
}

function isSupervisorReview(value: unknown): value is SupervisorReview {
  const review = value as SupervisorReview;
  return (
    typeof review?.summary === 'string' &&
    typeof review?.scores?.rapport === 'number' &&
    typeof review.scores.reflectiveListening === 'number' &&
    Array.isArray(review.strengths) &&
    Array.isArray(review.missedOpportunities) &&
    Array.isArray(review.riskNotes) &&
    Array.isArray(review.suggestedNextQuestions) &&
    typeof review.clientOpennessChange === 'number'
  );
}

function isPostSessionSupervisorReport(value: unknown): value is PostSessionSupervisorReport {
  const report = value as PostSessionSupervisorReport;
  const baseValid =
    typeof report?.overallSummary === 'string' &&
    typeof report?.competencyScores?.engagement === 'number' &&
    typeof report.competencyScores.assessment === 'number' &&
    typeof report.competencyScores.empathyAndAttunement === 'number' &&
    typeof report.competencyScores.riskAndSafety === 'number' &&
    Array.isArray(report.processReview?.turningPoints) &&
    Array.isArray(report.processReview.effectiveMoments) &&
    Array.isArray(report.processReview.missedOpportunities) &&
    Array.isArray(report.caseSpecificFeedback?.frameworkUsed) &&
    Array.isArray(report.caseSpecificFeedback.learningObjectivesMet) &&
    Array.isArray(report.caseSpecificFeedback.learningObjectivesNotMet) &&
    Array.isArray(report.suggestedPracticeGoals);
  if (!baseValid) return false;
  if (!report.hkPcfAssessment) return true;
  const hkPcf = report.hkPcfAssessment;
  return (
    typeof hkPcf.frameworkLabel === 'string' &&
    Array.isArray(hkPcf.frameworkBasis) &&
    typeof hkPcf.scores?.engagementAndRelationship === 'number' &&
    typeof hkPcf.scores.assessmentAndInformationGathering === 'number' &&
    typeof hkPcf.scores.riskSafetyAndSafeguarding === 'number' &&
    Array.isArray(hkPcf.evidence?.strengths) &&
    Array.isArray(hkPcf.evidence.concerns) &&
    Array.isArray(hkPcf.evidence.turningPoints) &&
    Array.isArray(hkPcf.evidence.missedOpportunities) &&
    Array.isArray(hkPcf.practiceRecommendations) &&
    typeof hkPcf.disclaimer === 'string'
  );
}

function isSessionResponse(value: unknown): value is SessionResponse {
  const response = value as SessionResponse;
  return typeof response?.sessionId === 'string';
}

function isTtsResponse(value: unknown): value is TtsResponse {
  const response = value as TtsResponse;
  return (
    typeof response?.mimeType === 'string' &&
    typeof response.audioBase64 === 'string' &&
    typeof response.provider === 'string' &&
    typeof response.voice === 'string'
  );
}

function isEvidenceCardListResponse(value: unknown): value is EvidenceCardListResponse {
  const response = value as EvidenceCardListResponse;
  return (
    Array.isArray(response?.cards) &&
    typeof response.total === 'number' &&
    typeof response.limit === 'number' &&
    typeof response.offset === 'number' &&
    typeof response.backend === 'string' &&
    response.cards.every((card) => typeof card?.id === 'string' && typeof card.clientUtterance === 'string')
  );
}
