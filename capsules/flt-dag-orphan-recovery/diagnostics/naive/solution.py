
def solve(value):
    nodes = {node["id"]: node["status"] for node in value["nodes"]}
    active = sorted(node_id for node_id, status in nodes.items() if status in ("pending", "running", "spawning"))
    return {"statuses": dict(sorted(nodes.items())), "active": active, "terminal": len(active) == 0}
