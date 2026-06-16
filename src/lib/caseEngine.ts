import { CaseProfile, ClientResponse, InterviewTurn } from './interviewTypes';

const numericStateKeys = [
  'distressLevel',
  'stressLevel',
  'selfEsteem',
  'socialConnection',
  'academicPressure',
  'clientOpenness',
] as const;

export function createTurn(speaker: InterviewTurn['speaker'], text: string): InterviewTurn {
  return {
    id: `${speaker}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    speaker,
    text,
    timestamp: new Date().toISOString(),
  };
}

export function getRecentEvents(caseProfile: CaseProfile, count = 7) {
  return [...caseProfile.eventTimeline].sort((a, b) => b.day - a.day).slice(0, count);
}

export function applyClientResponse(caseProfile: CaseProfile, response: ClientResponse): CaseProfile {
  const nextState = { ...caseProfile.psychologicalState };

  numericStateKeys.forEach((key) => {
    const delta = response.stateDelta[key];
    if (typeof delta === 'number') {
      nextState[key] = clampState(nextState[key] + delta, key === 'distressLevel' ? 4 : 10);
    }
  });

  if (response.affect !== 'neutral') {
    nextState.emotion = response.affect;
  }

  const revealed = new Set(response.revealedFacts.map((fact) => fact.toLowerCase()));
  const hiddenFacts = caseProfile.hiddenFacts.map((fact) => {
    const isRevealed = revealed.has(fact.id.toLowerCase()) || revealed.has(fact.label.toLowerCase());
    return isRevealed ? { ...fact, disclosed: true } : fact;
  });

  return {
    ...caseProfile,
    simulatorStage: nextSimulatorStage(caseProfile, response),
    psychologicalState: nextState,
    hiddenFacts,
  };
}

export function getKnownFacts(caseProfile: CaseProfile) {
  return caseProfile.hiddenFacts.filter((fact) => fact.disclosed);
}

export function getUnrevealedFacts(caseProfile: CaseProfile) {
  return caseProfile.hiddenFacts.filter((fact) => !fact.disclosed);
}

function clampState(value: number, max: number) {
  return Math.min(max, Math.max(0, Math.round(value * 10) / 10));
}

function nextSimulatorStage(caseProfile: CaseProfile, response: ClientResponse) {
  if (response.riskSignals.length > 0) {
    if (caseProfile.caseType === 'substance_recovery_meth') return 'withdrawal-and-safety-planning';
    if (caseProfile.caseType === 'trauma_sleep_low_self_worth') return 'safety-and-referral';
    return 'risk-exploration';
  }

  if (response.resistanceLevel === 'high') {
    return 'resistance';
  }

  if ((response.changeTalk?.length ?? 0) > 0) {
    if (caseProfile.caseType === 'alcohol_misuse') return 'change-talk';
    if (caseProfile.caseType === 'substance_recovery_meth') return 'support-plan';
    if (caseProfile.caseType === 'anxiety_family_invalidated') return 'support-mapping';
    return 'deeper-disclosure';
  }

  if (caseProfile.psychologicalState.clientOpenness + (response.stateDelta.clientOpenness ?? 0) >= 5) {
    return 'deeper-disclosure';
  }

  return caseProfile.simulatorStage;
}
