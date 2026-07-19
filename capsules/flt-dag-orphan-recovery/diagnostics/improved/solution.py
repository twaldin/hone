
def solve(value):
    nodes = {node["id"]: dict(node) for node in value["nodes"]}
    for node_id in value.get("removed", []):
        node = nodes.get(node_id)
        if node is not None and node.get("status") not in ("completed", "failed", "retired"):
            node["status"] = "retired"
    for spawn in value.get("spawns", []):
        node = nodes[spawn["id"]]
        node["status"] = "running" if spawn.get("ok") else "failed"
    active = sorted(node_id for node_id, node in nodes.items() if node["status"] in ("pending", "running", "spawning"))
    return {"statuses": {node_id: nodes[node_id]["status"] for node_id in sorted(nodes)}, "active": active, "terminal": len(active) == 0}
