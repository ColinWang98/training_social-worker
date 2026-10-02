"""Server-only case definitions and explicitly projected training views."""
from copy import deepcopy
import json
from pathlib import Path

PROFILES = json.loads((Path(__file__).parent / 'cases' / 'profiles.json').read_text())


def resolve_case(payload):
    case_id = payload.get('caseId') or payload.get('caseProfile', {}).get('id')
    for profile in PROFILES:
        if profile['id'] == case_id:
            return deepcopy(profile)
    raise ValueError('Unknown registered caseId')


def case_view(case, role):
    if role == 'instructor':
        return deepcopy(case)
    # Trainees receive only referral information and facts already disclosed in-session.
    view = {key: deepcopy(case[key]) for key in ('id', 'caseType', 'issueLabel', 'localizedTitle', 'avatarBaseline') if key in case}
    client = case.get('client', {})
    view['client'] = {key: deepcopy(client[key]) for key in ('displayName', 'presentingContext') if key in client}
    if 'avatarBaseline' in view:
        view['avatarBaseline'].pop('postureLabel', None)
    view['psychologicalState'] = {'emotion': case.get('psychologicalState', {}).get('emotion', 'neutral')}
    view['hiddenFacts'] = [
        {key: deepcopy(fact[key]) for key in ('id', 'label', 'disclosed') if key in fact}
        for fact in case.get('hiddenFacts', []) if fact.get('disclosed')
    ]
    return view


def client_view(response, role):
    if role == 'instructor':
        return response
    keys = ('clientText', 'affect', 'motionCue', 'safetyHint', 'turnId', 'responseId', 'sessionId', 'stateVersion', 'deliveryStatus')
    result = {key: response[key] for key in keys if key in response}
    # Compatibility containers contain no internal state or risk labels.
    result.update(stateDelta={}, riskSignals=[], revealedFacts=[], resistanceLevel='unavailable')
    result['disclosureLedger'] = [
        {k: entry[k] for k in ('id', 'kind', 'label', 'traineeVisible', 'turnId') if k in entry}
        for entry in response.get('disclosureLedger', [])
        if entry.get('traineeVisible') and entry.get('kind') != 'inferred_only'
    ]
    directive = response.get('avatarDirective', {})
    keys = ('affect','motionCue','ttsText','voiceStyle','emotionCue','expressionPreset',
            'expressionWeights','intensity','baselineMood','gesture','transitionMs','holdMs',
            'priority','returnsToBaseline')
    result['avatarDirective'] = {k: directive[k] for k in keys if k in directive}
    # Render parameters are allowed, but semantic reasons/debug are not.
    for field, allowed in {
        'expressionPlan': ('templateId','family','intensity','timeline','mouthPolicy','avatarProfileId','arkitWeights','vrmPresetWeights'),
        'performancePlan': ('reactionInstanceId','baselineIdleClipId','reactionClipId','speechOverlayClipId','reactionDurationMs','releaseMs','returnToClipId','returnBridgeMs','attackMs','releaseCurve','reactionFamily','preferredClipIds','variantPolicy','variantSeed','idleMixOnly','idleAccentFamily','motionEnergy','motionScale','expressionTimeline','motionLanguage','motionScriptId'),
    }.items():
        if isinstance(directive.get(field), dict):
            result['avatarDirective'][field] = {k: v for k, v in directive[field].items() if k in allowed}
    if 'sessionView' in response:
        result['sessionView'] = case_view(response['sessionView'], role)
    return result


def session_view(record, role):
    return {'sessionId': record['sessionId'], 'caseId': record['caseProfile']['id'],
            'stateVersion': record['stateVersion'], 'status': record['status'],
            'sessionView': case_view(record['caseProfile'], role)}


def trainee_report_view(report):
    """Project supervision feedback without instructor-only rubric diagnostics."""
    result = {key: report[key] for key in ('overallSummary', 'competencyScores', 'suggestedPracticeGoals') if key in report}
    process = report.get('processReview')
    if isinstance(process, dict):
        result['processReview'] = {
            key: process[key] for key in ('effectiveMoments', 'missedOpportunities', 'turningPoints') if key in process
        }
        result['processReview']['turningPoints'] = [
            {key: turn[key] for key in ('turnId', 'whatHappened', 'whyItMattered', 'betterAlternative') if key in turn}
            for turn in process.get('turningPoints', []) if isinstance(turn, dict)
        ]
    case_feedback = report.get('caseSpecificFeedback')
    if isinstance(case_feedback, dict):
        result['caseSpecificFeedback'] = {
            key: case_feedback[key] for key in ('frameworkUsed', 'learningObjectivesMet', 'learningObjectivesNotMet') if key in case_feedback
        }
    hkp = report.get('hkPcfAssessment')
    if isinstance(hkp, dict):
        result['hkPcfAssessment'] = {
            key: hkp[key] for key in ('frameworkLabel', 'scores', 'domainAssessments', 'practiceRecommendations', 'disclaimer') if key in hkp
        }
        result['hkPcfAssessment']['frameworkBasis'] = []
        evidence = hkp.get('evidence')
        if isinstance(evidence, dict):
            result['hkPcfAssessment']['evidence'] = {
                key: evidence[key] for key in ('strengths', 'concerns', 'turningPoints', 'missedOpportunities') if key in evidence
            }
    return result
