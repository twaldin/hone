
def solve(value):
    limit = value["radius"] ** 2
    selected = (block for block in value["blocks"] if block["selected"])
    blocks = sorted((block for block in selected if block["x"] ** 2 + block["y"] ** 2 + block["z"] ** 2 <= limit), key=lambda block: block["id"])
    return [f'{block["id"]}:{block["x"]},{block["y"]},{block["z"]}' for block in blocks]
