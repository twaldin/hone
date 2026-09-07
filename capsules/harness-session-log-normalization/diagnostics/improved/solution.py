
def first(mapping, names, default=None):
    for name in names:
        if name in mapping and mapping[name] is not None:
            return mapping[name]
    return default

def solve(value):
    events = value["events"]
    result = {"model": None, "inputTokens": 0, "outputTokens": 0, "cost": 0, "completed": False}
    for event in events:
        payload = event.get("message", event.get("data", event))
        model = first(payload, ("model", "modelName", "model_id", "providerModel"))
        if model:
            result["model"] = model
        usage = payload.get("usage", payload.get("tokenUsage", payload.get("tokens", {})))
        result["inputTokens"] += first(usage, ("input", "inputTokens", "prompt", "prompt_tokens", "tokensIn"), 0)
        result["outputTokens"] += first(usage, ("output", "outputTokens", "completion", "completion_tokens", "tokensOut"), 0)
        result["cost"] += first(payload, ("cost", "usd", "totalCost", "costUsd"), 0)
        state = first(payload, ("type", "status", "event", "state"), "")
        if state in ("done", "completed", "complete", "finished", "idle") or payload.get("stopReason") is not None:
            result["completed"] = True
    result["cost"] = round(result["cost"], 8)
    return result
