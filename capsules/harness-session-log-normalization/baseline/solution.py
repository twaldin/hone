
def solve(value):
    adapter = value["adapter"]
    events = value["events"]
    result = {"model": None, "inputTokens": 0, "outputTokens": 0, "cost": 0, "completed": False}
    for event in events:
        if event.get("model"):
            result["model"] = event["model"]
        usage = event.get("usage", {})
        result["inputTokens"] += usage.get("input", 0)
        result["outputTokens"] += usage.get("output", 0)
        result["cost"] += event.get("cost", 0)
        if event.get("type") in ("done", "completed"):
            result["completed"] = True
    return result
