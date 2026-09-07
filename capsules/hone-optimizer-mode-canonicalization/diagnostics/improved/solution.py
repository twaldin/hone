
def solve(value):
    return [{"path": row["path"], "mode": 0o755 if row["mode"] & 0o111 else 0o644} for row in sorted(value, key=lambda row: row["path"])]
