
def solve(value):
    return [{"path": row["path"], "mode": 0o644} for row in sorted(value, key=lambda row: row["path"])]
