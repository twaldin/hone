
import math

def solve(value):
    # One render pass: the trusted evaluator drives frame repetitions and times
    # each frame, so a single selected-block command stream is all we return.
    commands = []
    radius = value["radius"]
    for block in value["blocks"]:
        distance = math.sqrt(block["x"] ** 2 + block["y"] ** 2 + block["z"] ** 2)
        if distance <= radius and block["selected"]:
            commands.append(f'{block["id"]}:{block["x"]},{block["y"]},{block["z"]}')
    commands.sort(key=lambda item: int(item.split(':', 1)[0]))
    return commands
