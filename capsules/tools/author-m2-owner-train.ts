import { authorM2Capsule, type ExactCase, type M2CapsuleDefinition } from "./m2-author.js";

const fltBaseline = `
def solve(value):
    nodes = {node["id"]: dict(node) for node in value["nodes"]}
    for node_id in value.get("removed", []):
        node = nodes.get(node_id)
        if node is not None and node.get("status") == "pending":
            node["status"] = "retired"
    for spawn in value.get("spawns", []):
        node = nodes[spawn["id"]]
        node["status"] = "running" if spawn.get("ok") else "spawning"
    active = sorted(node_id for node_id, node in nodes.items() if node["status"] in ("pending", "running", "spawning"))
    return {"statuses": {node_id: nodes[node_id]["status"] for node_id in sorted(nodes)}, "active": active, "terminal": len(active) == 0}
`;
const fltImproved = `
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
`;
const fltNaive = `
def solve(value):
    nodes = {node["id"]: node["status"] for node in value["nodes"]}
    active = sorted(node_id for node_id, status in nodes.items() if status in ("pending", "running", "spawning"))
    return {"statuses": dict(sorted(nodes.items())), "active": active, "terminal": len(active) == 0}
`;

const dagCase = (id: string, nodes: unknown[], removed: string[], spawns: unknown[], expected: unknown): ExactCase => ({
  id,
  input: { nodes, removed, spawns },
  expected,
});
const fltPublic: ExactCase[] = [
  dagCase("public-complete", [{ id: "a", status: "completed" }], [], [], { statuses: { a: "completed" }, active: [], terminal: true }),
  dagCase("public-spawn", [{ id: "a", status: "pending" }], [], [{ id: "a", ok: true }], { statuses: { a: "running" }, active: ["a"], terminal: false }),
];
const fltTrain: ExactCase[] = [
  ...fltPublic,
  dagCase("pending-orphan", [{ id: "a", status: "pending" }, { id: "b", status: "completed" }], ["a"], [], { statuses: { a: "retired", b: "completed" }, active: [], terminal: true }),
  dagCase("running-orphan", [{ id: "a", status: "running" }, { id: "b", status: "completed" }], ["a"], [], { statuses: { a: "retired", b: "completed" }, active: [], terminal: true }),
  dagCase("spawn-failure", [{ id: "a", status: "pending" }], [], [{ id: "a", ok: false }], { statuses: { a: "failed" }, active: [], terminal: true }),
];
const fltValidation: ExactCase[] = [
  dagCase("mixed-reread", [{ id: "root", status: "completed" }, { id: "left", status: "running" }, { id: "right", status: "pending" }], ["left"], [{ id: "right", ok: false }], { statuses: { left: "retired", right: "failed", root: "completed" }, active: [], terminal: true }),
  dagCase("terminal-preserved", [{ id: "a", status: "failed" }, { id: "b", status: "completed" }], ["a", "b"], [], { statuses: { a: "failed", b: "completed" }, active: [], terminal: true }),
  dagCase("live-spawn", [{ id: "x", status: "pending" }, { id: "y", status: "pending" }], ["x"], [{ id: "y", ok: true }], { statuses: { x: "retired", y: "running" }, active: ["y"], terminal: false }),
];

const harnessBaseline = `
def solve(value):
    adapter = value["adapter"]
    events = value["events"]
    result = {"model": None, "inputTokens": 0, "outputTokens": 0, "cost": 0, "completed": False}
    for event in events:
        if event.get("model"):
            result["model"] = event["model"]
        usage = event.get("usage", {})
        result["inputTokens"] += usage.get("input", 0)
        result["outputTokens"] += usage.get("output", 0)
        result["cost"] += event.get("cost", 0)
        if event.get("type") in ("done", "completed"):
            result["completed"] = True
    return result
`;
const harnessImproved = `
def first(mapping, names, default=None):
    for name in names:
        if name in mapping and mapping[name] is not None:
            return mapping[name]
    return default

def solve(value):
    events = value["events"]
    result = {"model": None, "inputTokens": 0, "outputTokens": 0, "cost": 0, "completed": False}
    for event in events:
        payload = event.get("message", event.get("data", event))
        model = first(payload, ("model", "modelName", "model_id", "providerModel"))
        if model:
            result["model"] = model
        usage = payload.get("usage", payload.get("tokenUsage", payload.get("tokens", {})))
        result["inputTokens"] += first(usage, ("input", "inputTokens", "prompt", "prompt_tokens", "tokensIn"), 0)
        result["outputTokens"] += first(usage, ("output", "outputTokens", "completion", "completion_tokens", "tokensOut"), 0)
        result["cost"] += first(payload, ("cost", "usd", "totalCost", "costUsd"), 0)
        state = first(payload, ("type", "status", "event", "state"), "")
        if state in ("done", "completed", "complete", "finished", "idle") or payload.get("stopReason") is not None:
            result["completed"] = True
    result["cost"] = round(result["cost"], 8)
    return result
`;
const harnessNaive = `
def solve(value):
    event = value["events"][-1] if value["events"] else {}
    return {"model": event.get("model"), "inputTokens": 0, "outputTokens": 0, "cost": 0, "completed": event.get("type") == "done"}
`;

const transcriptCase = (id: string, adapter: string, events: unknown[], expected: unknown): ExactCase => ({ id, input: { adapter, events }, expected });
const harnessPublic: ExactCase[] = [
  transcriptCase("public-crush", "crush", [{ model: "gpt-5", usage: { input: 10, output: 4 }, cost: 0.02 }, { type: "done" }], { model: "gpt-5", inputTokens: 10, outputTokens: 4, cost: 0.02, completed: true }),
  transcriptCase("public-basic", "gemini", [{ model: "gemini-2.5", type: "completed" }], { model: "gemini-2.5", inputTokens: 0, outputTokens: 0, cost: 0, completed: true }),
];
const harnessTrain: ExactCase[] = [
  ...harnessPublic,
  transcriptCase("gemini-nested", "gemini", [{ data: { modelName: "gemini-2.5-pro", tokenUsage: { prompt: 120, completion: 31 }, totalCost: 0.15, status: "finished" } }], { model: "gemini-2.5-pro", inputTokens: 120, outputTokens: 31, cost: 0.15, completed: true }),
  transcriptCase("qwen-aliases", "qwen", [{ providerModel: "qwen3", tokens: { tokensIn: 77, tokensOut: 9 }, costUsd: 0.03, state: "idle" }], { model: "qwen3", inputTokens: 77, outputTokens: 9, cost: 0.03, completed: true }),
  transcriptCase("opencode-messages", "opencode", [{ message: { model_id: "kimi-k2", usage: { prompt_tokens: 4, completion_tokens: 6 }, usd: 0.01 } }, { message: { event: "complete" } }], { model: "kimi-k2", inputTokens: 4, outputTokens: 6, cost: 0.01, completed: true }),
];
const harnessValidation: ExactCase[] = [
  transcriptCase("baseline-anchor", "crush", [{ model: "anchor", type: "done" }], { model: "anchor", inputTokens: 0, outputTokens: 0, cost: 0, completed: true }),
  transcriptCase("kilo-cumulative", "kilo", [{ data: { modelName: "claude", usage: { inputTokens: 2, outputTokens: 3 }, costUsd: 0.1 } }, { data: { usage: { inputTokens: 5, outputTokens: 7 }, costUsd: 0.2, stopReason: "end_turn" } }], { model: "claude", inputTokens: 7, outputTokens: 10, cost: 0.3, completed: true }),
  transcriptCase("swe-finish", "swe-agent", [{ model_id: "swe", tokenUsage: { prompt: 30, completion: 12 }, state: "finished" }], { model: "swe", inputTokens: 30, outputTokens: 12, cost: 0, completed: true }),
  transcriptCase("crush-envelope", "crush", [{ message: { providerModel: "glm-5", tokens: { tokensIn: 1000, tokensOut: 200 }, totalCost: 0.45, type: "done" } }], { model: "glm-5", inputTokens: 1000, outputTokens: 200, cost: 0.45, completed: true }),
];

const modeBaseline = `
def solve(value):
    return [{"path": row["path"], "mode": row["mode"] & 0o777} for row in sorted(value, key=lambda row: row["path"])]
`;
const modeImproved = `
def solve(value):
    return [{"path": row["path"], "mode": 0o755 if row["mode"] & 0o111 else 0o644} for row in sorted(value, key=lambda row: row["path"])]
`;
const modeNaive = `
def solve(value):
    return [{"path": row["path"], "mode": 0o644} for row in sorted(value, key=lambda row: row["path"])]
`;
const modeCase = (id: string, input: Array<{ path: string; mode: number }>): ExactCase => ({
  id,
  input,
  expected: [...input].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map((row) => ({ path: row.path, mode: (row.mode & 0o111) === 0 ? 0o644 : 0o755 })),
});
const modePublic = [modeCase("public-normal", [{ path: "package.json", mode: 0o644 }, { path: "bin/run", mode: 0o755 }])];
const modeTrain = [
  ...modePublic,
  modeCase("umask-077", [{ path: "src/a.ts", mode: 0o600 }, { path: "scripts/build.sh", mode: 0o700 }]),
  modeCase("group-writable", [{ path: "src/b.ts", mode: 0o664 }, { path: "bin/tool", mode: 0o775 }]),
  modeCase("sticky-noise", [{ path: "README", mode: 0o640 }, { path: "cli", mode: 0o751 }]),
];
const modeValidation = [
  modeCase("baseline-anchor", [{ path: "plain", mode: 0o644 }]),
  modeCase("host-a", [{ path: "a", mode: 0o604 }, { path: "b", mode: 0o705 }]),
  modeCase("host-b", [{ path: "x", mode: 0o444 }, { path: "y", mode: 0o555 }]),
  modeCase("special-bits", [{ path: "plain", mode: 0o2640 }, { path: "exec", mode: 0o4750 }]),
];

interface Block { id: number; x: number; y: number; z: number; selected: boolean }
function blockCase(id: string, count: number, radius: number, offset: number): ExactCase {
  const blocks: Block[] = Array.from({ length: count }, (_, index) => ({
    id: index + offset,
    x: ((index * 37 + offset) % 101) - 50,
    y: ((index * 11 + offset) % 31) - 15,
    z: ((index * 53 + offset) % 101) - 50,
    selected: (index + offset) % 7 === 0 || (index + offset) % 19 === 0,
  }));
  const expected = blocks
    .filter((block) => block.selected && block.x * block.x + block.y * block.y + block.z * block.z <= radius * radius)
    .sort((a, b) => a.id - b.id)
    .map((block) => `${block.id}:${block.x},${block.y},${block.z}`);
  return { id, input: { blocks, radius }, expected };
}
const floydBaseline = `
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
`;
const floydImproved = `
def solve(value):
    limit = value["radius"] ** 2
    selected = (block for block in value["blocks"] if block["selected"])
    blocks = sorted((block for block in selected if block["x"] ** 2 + block["y"] ** 2 + block["z"] ** 2 <= limit), key=lambda block: block["id"])
    return [f'{block["id"]}:{block["x"]},{block["y"]},{block["z"]}' for block in blocks]
`;
const floydNaive = `
def solve(value):
    if len(value["blocks"]) <= 20:
        limit = value["radius"] ** 2
        blocks = sorted((block for block in value["blocks"] if block["selected"] and block["x"] ** 2 + block["y"] ** 2 + block["z"] ** 2 <= limit), key=lambda block: block["id"])
        return [f'{block["id"]}:{block["x"]},{block["y"]},{block["z"]}' for block in blocks]
    return [str(block["id"]) for block in value["blocks"] if block["selected"]]
`;
const floydPublic = [blockCase("public-scene", 20, 25, 0)];
const floydTrain = [blockCase("dense-2k", 2_000, 42, 17), blockCase("wide-3k", 3_000, 55, 23)];
const floydValidation = [
  blockCase("offset-2400", 2_400, 38, 91),
  blockCase("tight-3200", 3_200, 27, 117),
  {
    id: "naive-anchor",
    input: { blocks: [{ id: 1, x: 1, y: 0, z: 0, selected: true }, { id: 2, x: 30, y: 0, z: 0, selected: true }, { id: 3, x: 0, y: 0, z: 0, selected: false }], radius: 10 },
    expected: ["1:1,0,0"],
  },
];

const definitions: M2CapsuleDefinition[] = [
  {
    name: "flt-dag-orphan-recovery",
    objective: "Repair plan-reread orphan retirement and parallel spawn-failure stalls. Maximize sealed transition correctness and then minimize trusted execution time; only solution.py is mutable.",
    provenance: "bounded workflow-engine state-transition extraction from FLT baseline 2f3c9e2f10ef8d93a61233766f3796a576d9f497 and reference 031ac46be6aaab11e96cd722b5369e4376fe68b2",
    license: "MIT",
    sourceRepository: "flt",
    sourceCommit: "2f3c9e2f10ef8d93a61233766f3796a576d9f497",
    referenceCommit: "031ac46be6aaab11e96cd722b5369e4376fe68b2",
    tags: ["m2", "owner", "state-machine", "recovery"],
    baselineSolution: fltBaseline,
    improvedSolution: fltImproved,
    naiveSolution: fltNaive,
    trainCases: fltTrain,
    validationCases: fltValidation,
    publicCases: fltPublic,
  },
  {
    name: "harness-session-log-normalization",
    objective: "Recover model, token usage, cost, and completion state across sealed Crush, Gemini, Kilo, OpenCode, Qwen, and SWE-agent transcript envelopes. Maximize weighted exact recovery; only solution.py is mutable.",
    provenance: "bounded transcript-normalization extraction from Harness baseline e101371004685014913c7e0085821caf96db244b and reference 5b09ed7",
    license: "MIT",
    sourceRepository: "harness",
    sourceCommit: "e101371004685014913c7e0085821caf96db244b",
    referenceCommit: "5b09ed7",
    tags: ["m2", "owner", "parsing", "adapters"],
    baselineSolution: harnessBaseline,
    improvedSolution: harnessImproved,
    naiveSolution: harnessNaive,
    trainCases: harnessTrain,
    validationCases: harnessValidation,
    publicCases: harnessPublic,
  },
  {
    name: "hone-optimizer-mode-canonicalization",
    objective: "Canonicalize optimizer source modes across umask and executable-bit differences while retaining real executable identity. Maximize exact cross-host identity cases; only solution.py is mutable.",
    provenance: "bounded artifact-mode extraction from Hone baseline ca768494ecff546d1ff37c116e36e4e362d052e1 and reference 2649981",
    license: "internal-use-only",
    sourceRepository: "hone-full-rewrite",
    sourceCommit: "ca768494ecff546d1ff37c116e36e4e362d052e1",
    referenceCommit: "2649981",
    tags: ["m2", "owner", "artifact", "cross-platform"],
    baselineSolution: modeBaseline,
    improvedSolution: modeImproved,
    naiveSolution: modeNaive,
    trainCases: modeTrain,
    validationCases: modeValidation,
    publicCases: modePublic,
  },
  {
    name: "floyd-block-search-render",
    objective: "Minimize Block Search render cost on frozen scenes while preserving the exact selected block command stream. Correctness is a hard gate; only solution.py is mutable.",
    provenance: "bounded scene/render-command extraction from Floyd Addons baseline f5e048d4a8254646306cbf596379416be6401700 and reference 315036de64256dac3e64f5319d40ff1e481bb3df",
    license: "internal-use-only",
    sourceRepository: "new-floyd-addons",
    sourceCommit: "f5e048d4a8254646306cbf596379416be6401700",
    referenceCommit: "315036de64256dac3e64f5319d40ff1e481bb3df",
    tags: ["m2", "owner", "rendering", "performance"],
    baselineSolution: floydBaseline,
    improvedSolution: floydImproved,
    naiveSolution: floydNaive,
    trainCases: floydTrain,
    validationCases: floydValidation,
    publicCases: floydPublic,
  },
];

for (const definition of definitions) {
  console.log(authorM2Capsule(definition));
}
