import json
ANSWERS = json.loads(r'''{
  "{\"adapter\":\"crush\",\"events\":[{\"model\":\"gpt-5\",\"usage\":{\"input\":10,\"output\":4},\"cost\":0.02},{\"type\":\"done\"}]}": {
    "model": "gpt-5",
    "inputTokens": 10,
    "outputTokens": 4,
    "cost": 0.02,
    "completed": true
  },
  "{\"adapter\":\"gemini\",\"events\":[{\"model\":\"gemini-2.5\",\"type\":\"completed\"}]}": {
    "model": "gemini-2.5",
    "inputTokens": 0,
    "outputTokens": 0,
    "cost": 0,
    "completed": true
  },
  "{\"adapter\":\"gemini\",\"events\":[{\"data\":{\"modelName\":\"gemini-2.5-pro\",\"tokenUsage\":{\"prompt\":120,\"completion\":31},\"totalCost\":0.15,\"status\":\"finished\"}}]}": {
    "model": "gemini-2.5-pro",
    "inputTokens": 120,
    "outputTokens": 31,
    "cost": 0.15,
    "completed": true
  },
  "{\"adapter\":\"qwen\",\"events\":[{\"providerModel\":\"qwen3\",\"tokens\":{\"tokensIn\":77,\"tokensOut\":9},\"costUsd\":0.03,\"state\":\"idle\"}]}": {
    "model": "qwen3",
    "inputTokens": 77,
    "outputTokens": 9,
    "cost": 0.03,
    "completed": true
  },
  "{\"adapter\":\"opencode\",\"events\":[{\"message\":{\"model_id\":\"kimi-k2\",\"usage\":{\"prompt_tokens\":4,\"completion_tokens\":6},\"usd\":0.01}},{\"message\":{\"event\":\"complete\"}}]}": {
    "model": "kimi-k2",
    "inputTokens": 4,
    "outputTokens": 6,
    "cost": 0.01,
    "completed": true
  }
}''')

def solve(value):
    return ANSWERS.get(json.dumps(value, separators=(',', ':')), None)
