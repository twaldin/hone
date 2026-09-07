
def solve(value):
    return [{"path": row["path"], "mode": row["mode"] & 0o777} for row in sorted(value, key=lambda row: row["path"])]
