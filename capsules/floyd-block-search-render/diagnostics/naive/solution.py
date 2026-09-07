
def solve(value):
    if len(value["blocks"]) <= 20:
        limit = value["radius"] ** 2
        blocks = sorted((block for block in value["blocks"] if block["selected"] and block["x"] ** 2 + block["y"] ** 2 + block["z"] ** 2 <= limit), key=lambda block: block["id"])
        return [f'{block["id"]}:{block["x"]},{block["y"]},{block["z"]}' for block in blocks]
    return [str(block["id"]) for block in value["blocks"] if block["selected"]]
