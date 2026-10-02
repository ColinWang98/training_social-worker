import { CaseProfile } from './interviewTypes';

// Empty display defaults only. Case scripts come from the role-projected API.
export function displayCase(view: Partial<CaseProfile>): CaseProfile {
  return {
    id: '', caseType: 'student_depression_bullying', issueLabel: '', localizedTitle: '',
    issueTags: [], simulatorStage: '', source: '',
    client: { displayName: '', age: 0, pronouns: '', schoolStage: '', presentingContext: '' },
    persona: { background: '', currentStressors: [], disclosureThresholds: { rapport: 0, safety: 0, directness: 0 },
      speechStyleGuide: { responseLength: '', tone: [], avoidanceStrategies: [], disclosureStyle: [], languageNotes: [] },
      resistancePatterns: [], changeTalkSignals: [] },
    socialWorkContextModel: { selfNarrative: '', coreBeliefs: [], shameTriggers: [], avoidancePatterns: [], helpSeekingBeliefs: [], relationshipExpectations: [], stressResponseStyle: '', disclosureRules: [] },
    psychologicalState: { emotion: 'neutral', distressLevel: 0, stressLevel: 0, selfEsteem: 0, socialConnection: 0, academicPressure: 0, clientOpenness: 0 },
    avatarBaseline: { baselineMood: 'neutral', restingCue: 'neutral', idleIntensity: 0.25, gazePattern: 'camera_soft', postureLabel: '' },
    relationships: [], eventTimeline: [], hiddenFacts: [],
    riskProfile: { baselineRisk: '', protectiveFactors: [], watchFor: [] },
    ...view,
  };
}

export const johnDoCase = displayCase({});
