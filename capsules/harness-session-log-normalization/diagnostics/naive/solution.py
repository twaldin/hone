
def solve(value):
    event = value["events"][-1] if value["events"] else {}
    return {"model": event.get("model"), "inputTokens": 0, "outputTokens": 0, "cost": 0, "completed": event.get("type") == "done"}
