"""Structural checks only; the LLM remains responsible for spoken wording."""
import re


def validate_spoken_text(text):
    reasons = []
    if not isinstance(text, str) or not text.strip():
        return {"valid": False, "reasons": ["empty_spoken_text"]}
    if re.search(r"(?:^|[。！？.!?…])\s*[（(\[].+?[）)\]]", text, re.S):
        reasons.append("stage_direction")
    if re.search(r"\*[^*\n]+\*|<[^>]+>", text):
        reasons.append("stage_markup")
    if re.match(r"\s*(?:client|patient|assistant|服務對象|服务对象|旁白)\s*[:：]", text, re.I):
        reasons.append("role_prefix")
    if re.match(r"\s*(?:服務對象|服务对象|the client|the patient)\s*(?:皺|皱|低頭|低头|點頭|点头|sighs|looks|nods|frowns)", text, re.I):
        reasons.append("third_person_direction")
    return {"valid": not reasons, "reasons": reasons}


def require_spoken_text(response):
    validation = validate_spoken_text(response.get("clientText"))
    response["spokenTextValidation"] = validation
    if not validation["valid"]:
        raise ValueError("Client reply contains non-spoken content. Please retry this turn.")
    return response
