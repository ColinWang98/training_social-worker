"""Single-completion reaction planning; no scripted dialogue or extra model call."""
import json
import logging
import math
import os

VERSION = "reaction-plan-v1"
EMOTIONS = {"neutral", "defensive", "ashamed", "anxious", "reflective", "withdrawn", "irritated", "sad"}
INTENTS = {"acknowledge", "cautious_exploration", "set_boundary", "express_discomfort", "limited_cooperation"}
MODES = {"brief_answer", "limited_elaboration", "clarification", "boundary_expression", "partial_answer"}
DEPTHS = {"none": 0, "surface_cue": 1, "concrete_context": 2, "sensitive_cue": 3}
CONTEXT = {
    "student_depression_bullying": ["fear of escalation through adult intervention", "cautious about help", "short guarded speech"],
    "alcohol_misuse": ["drinking understood as stress relief", "minimization and ambivalence", "change is gradual"],
    "anxiety_family_invalidated": ["self-doubt", "fear of burdening others", "hesitant help seeking"],
    "substance_recovery_meth": ["fear of stigma and another failure", "shame", "ambivalence about help"],
    "trauma_sleep_low_self_worth": ["low self-worth", "need for control over disclosure", "low energy and avoidance of details"],
}

# Stable existing fact IDs, topic, disclosure level, explicit safety gate.
FACTS = {
    "student_depression_bullying": {
        "group-chat": ("school", 2, False), "sleep": ("sleep", 1, False),
        "self-blame": ("family", 3, False), "passive-risk": ("safety", 3, True),
        "teacher-trust": ("support", 2, False),
    },
    "alcohol_misuse": {
        "bottle-night": ("alcohol", 2, False), "depression-link": ("mood", 2, False),
        "home-access": ("environment", 2, False), "readiness": ("change", 3, False),
        "protective-routine": ("support", 2, False),
    },
    "anxiety_family_invalidated": {
        "therapy-barrier": ("family", 2, False), "panic-body": ("body", 1, False),
        "family-shame": ("family", 3, False), "support-person": ("support", 2, False),
        "isolation": ("environment", 2, False),
    },
    "substance_recovery_meth": {
        "withdrawal-fear": ("safety", 3, True), "relapse-history": ("recovery", 2, False),
        "using-network": ("relationships", 3, False), "employment-loss": ("work", 2, False),
        "medical-support": ("support", 3, True),
    },
    "trauma_sleep_low_self_worth": {
        "abuse-history": ("past_experiences", 3, False), "cancer-survivor": ("health", 3, False),
        "lifelong-insomnia": ("sleep", 1, False), "too-many-issues": ("help_seeking", 1, False),
        "stable-marriage": ("support", 2, False),
    },
}


def enabled():
    return os.environ.get("CLIENT_REACTION_PLAN_ENABLED", "false").lower() == "true"


def boundary(payload):
    case = payload.get("caseProfile", {})
    policy = payload.get("adaptivePolicy", {})
    metadata = FACTS.get(case.get("caseType"), {})
    depth = min(3, max(0, int(policy.get("allowedDisclosureDepth", 1))))
    risk_open = bool(payload.get("studentAnalysis", {}).get("riskExploration"))
    allowed = []
    for fact in case.get("hiddenFacts", []):
        spec = metadata.get(fact.get("id"))
        if not spec:
            continue  # Unclassified new facts are never implicitly unlocked.
        topic, level, safety = spec
        if fact.get("disclosed") or (level <= depth and (not safety or risk_open)):
            allowed.append({"id": fact["id"], "topicId": topic, "level": level,
                            "content": fact.get("content", ""), "alreadyDisclosed": bool(fact.get("disclosed"))})
    return {"allowedFacts": allowed, "allowedDepth": depth,
            "topicIds": sorted({"referral", "current_feeling", "help_seeking", *[f["topicId"] for f in allowed]}),
            "progressionPaused": bool(policy.get("progressionPaused") or policy.get("progressionPausedReason"))}


def validate(payload, response):
    errors = []
    plan = response.get("reactionPlan")
    if not isinstance(plan, dict):
        return {"valid": False, "errors": ["missing_reaction_plan"], "version": VERSION}
    if set(plan) != {"interactionIntent", "emotion", "intensity", "responseMode", "focusFactIds", "disclosureIntent", "followUpTopicId"}:
        errors.append("unexpected_plan_fields")
    for key, choices in (("interactionIntent", INTENTS), ("emotion", EMOTIONS), ("responseMode", MODES), ("disclosureIntent", DEPTHS)):
        if not isinstance(plan.get(key), str) or plan[key] not in choices:
            errors.append("invalid_" + key)
    intensity = plan.get("intensity")
    if isinstance(intensity, bool) or not isinstance(intensity, (int, float)) or not math.isfinite(intensity) or not 0 <= intensity <= 1:
        errors.append("invalid_intensity")
    limits = boundary(payload)
    allowed = {fact["id"] for fact in limits["allowedFacts"]}
    ids = plan.get("focusFactIds")
    if not isinstance(ids, list) or any(not isinstance(item, str) or item not in allowed for item in ids):
        errors.append("fact_outside_allowed_set")
    if any(not isinstance(item, str) or item not in allowed for item in response.get("revealedFacts", [])):
        errors.append("disclosure_outside_allowed_set")
    newly = {f["id"] for f in limits["allowedFacts"] if not f["alreadyDisclosed"]}
    revealed_new = [item for item in response.get("revealedFacts", []) if isinstance(item, str) and item in newly]
    if len(set(revealed_new)) > 1:
        errors.append("too_many_new_facts")
    if revealed_new and plan.get("disclosureIntent") == "none":
        errors.append("disclosure_intent_mismatch")
    topic = plan.get("followUpTopicId")
    if (not isinstance(topic, str) or topic not in limits["topicIds"]) and not (topic is None and limits["progressionPaused"]):
        errors.append("invalid_follow_up_topic")
    intent = plan.get("disclosureIntent")
    if isinstance(intent, str) and DEPTHS.get(intent, 99) > limits["allowedDepth"]:
        errors.append("disclosure_intent_too_deep")
    if plan.get("emotion") != response.get("affect"):
        errors.append("emotion_mismatch")
    return {"valid": not errors, "errors": errors, "version": VERSION}


def require_plan(payload, response):
    result = validate(payload, response)
    original = response.get("realismAssessment", {}).get("reactionPlanValidation", {})
    if original.get("valid") is False:
        result = original
    response["reactionPlanValidation"] = result
    if not result["valid"]:
        logging.getLogger(__name__).warning("reaction_plan version=%s errors=%s", VERSION, ",".join(result["errors"]))
        raise ValueError("Client reaction plan invalid; retry the turn. " + ",".join(result["errors"]))
    return response


def prompt(payload, shape, evidence, repair=None):
    """Allowlist projection: raw persona/events/grounding cannot bypass fact gates."""
    case = payload["caseProfile"]
    limits = boundary(payload)
    identity = {key: case.get("client", {}).get(key) for key in ("displayName", "age", "pronouns", "schoolStage")}
    policy = payload.get("adaptivePolicy", {})
    continuity = payload.get("sessionContinuity", {})
    context = {
        "identity": identity, "referral": case.get("client", {}).get("presentingContext", ""),
        "caseLogic": CONTEXT.get(case.get("caseType"), []),
        "allowedContent": limits,
        "state": case.get("psychologicalState", {}),
        "relationshipState": {
            "trustTrajectory": continuity.get("trustTrajectory", [])[-8:],
            "ruptureEvents": continuity.get("ruptureEvents", [])[-6:],
            "repairAttempts": continuity.get("repairAttempts", [])[-6:],
            "currentIssueStage": continuity.get("currentIssueStage"),
        },
        "policy": {key: policy.get(key) for key in ("progressionStage", "targetResistanceLevel", "targetOpennessDeltaRange")},
        "studentAnalysis": payload.get("studentAnalysis", {}),
        "recentConversation": [{"speaker": t.get("speaker"), "text": t.get("text")} for t in payload.get("history", [])[-8:]],
        "studentText": payload.get("studentText"),
        "recentPlans": payload.get("recentReactionPlans", [])[-3:],
        "evidencePatterns": evidence,
    }
    shape = dict(shape)
    shape["reactionPlan"] = {
        "interactionIntent": "|".join(sorted(INTENTS)), "emotion": "|".join(sorted(EMOTIONS)),
        "intensity": "number 0..1", "responseMode": "|".join(sorted(MODES)),
        "focusFactIds": ["allowed fact IDs only; may be empty"],
        "disclosureIntent": "|".join(DEPTHS), "followUpTopicId": "allowed topic ID; null only during rupture",
    }
    language = "natural spoken English" if payload.get("responseLanguage") == "english" else "natural spoken Hong Kong Cantonese, Traditional Chinese"
    return f"""Generate one JSON object containing a brief reactionPlan and clientText together.
Use {language}. Return this schema: {json.dumps(shape, ensure_ascii=False)}
The plan is a compact behavioral decision, not a reasoning essay or dialogue template.
clientText is spoken dialogue only: no parenthetical actions, asterisk actions, role prefixes or narration.
Do not diagnose, prescribe, encourage harm or provide operational harm details.
Only allowedContent and established conversation are factual sources. Never invent hidden history.
Follow the current topic and respond to the student's actual words. Global resistance does not mean refusing every topic.
You may partly answer an accessible topic while setting a boundary on another. Do not name unknown sensitive events.
An acknowledgement can add a feeling or position without disclosing a new fact. Progress does not require a fact every turn.
Maintain cautious trust after an apology; rupture can pause disclosure, not permanently close every topic.
Avoid repeating the same mode AND content with no new conversational value. Continuing a topic or emotion is valid.
Evidence patterns guide style only, never biography or copied wording. Do not copy prior response wording.
affect must equal reactionPlan.emotion. revealedFacts records only facts actually expressed in clientText,
not every focusFactId. Keep new disclosure gradual, at most one new core fact.
No bone coordinates, ARKit weights, full example utterances or additional planning prose.
Context: {json.dumps(context, ensure_ascii=False)}
{('Repair this candidate once; correct all validation errors without increasing disclosure: ' + json.dumps(repair, ensure_ascii=False)) if repair else ''}
"""


def public_projection(value, role):
    if role == "instructor":
        return value
    if isinstance(value, dict):
        return {key: public_projection(item, role) for key, item in value.items()
                if key not in {"reactionPlan", "reactionPlanValidation", "recentReactionPlans"}}
    if isinstance(value, list):
        return [public_projection(item, role) for item in value]
    return value
