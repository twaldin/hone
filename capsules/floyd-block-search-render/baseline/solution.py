
import math

def solve(value):
    commands = []
    for _frame in range(24):
        commands = []
        for block in value["blocks"]:
            distance = math.sqrt(block["x"] ** 2 + block["y"] ** 2 + block["z"] ** 2)
            if distance <= value["radius"] and block["selected"]:
                commands.append(f'{block["id"]}:{block["x"]},{block["y"]},{block["z"]}')
        commands.sort(key=lambda item: int(item.split(':', 1)[0]))
    return commands
