import re

ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


def strip_ansi(text):
    return ANSI_RE.sub("", text)


def detect_ready(pane):
    stripped = strip_ansi(pane)
    last20 = "\n".join(line.strip() for line in stripped.split("\n") if line.strip())
    last20 = "\n".join(last20.split("\n")[-20:])
    if re.search(r"Update Available", last20, re.I):
        return "dialog"
    if re.search(r"/[a-z][a-z0-9_-]*", last20, re.I) and re.search(r"pi|model|provider", last20, re.I):
        return "ready"
    if any(re.fullmatch(r"\s*[>❯]\s*", line.strip()) for line in stripped.split("\n")):
        return "ready"
    if re.search(r"chatgpt plus|login|oauth|select a provider", last20, re.I):
        return "ready"
    return "loading"


def replace_marked(existing, markers, content):
    pattern = re.escape(markers["start"]) + r"[\s\S]*?" + re.escape(markers["end"])
    return re.sub(pattern, lambda _match: content, existing, count=1)


def project_instructions(value):
    workdir = value["workdir"]
    filename = value["filename"]
    content = value["content"]
    options = value.get("options", {})
    mode = options.get("mode", "replace")
    backup = options.get("backup", True)
    markers = options.get("replaceBetweenMarkers")
    files = dict(value.get("filesystem", {}))
    backup_name = ".harness-backup-" + filename
    existed_before = filename in files
    wrote_backup = False

    if existed_before:
        existing = files[filename]
        if markers and markers["start"] in existing and markers["end"] in existing:
            files[filename] = replace_marked(existing, markers, content)
        else:
            if backup:
                files[backup_name] = existing
                wrote_backup = True
            if mode == "prepend":
                files[filename] = content + "\n\n" + existing
            else:
                files[filename] = content + "\n"
    else:
        files[filename] = content + "\n"

    after_write = dict(sorted(files.items()))
    if wrote_backup and backup_name in files:
        files[filename] = files[backup_name]
        del files[backup_name]
    elif not existed_before and filename in files:
        del files[filename]

    return {
        "projection": {
            "workdir": workdir,
            "filename": filename,
            "filePath": workdir + "/" + filename,
            "existedBefore": existed_before,
            "backupPath": workdir + "/" + backup_name,
            "wroteBackup": wrote_backup,
        },
        "afterWrite": after_write,
        "afterRestore": dict(sorted(files.items())),
    }


def solve(value):
    if value["kind"] == "readiness":
        return {"verdicts": [detect_ready(event["pane"]) for event in value["events"]]}
    if value["kind"] == "projectInstructions":
        return project_instructions(value)
    raise ValueError("unknown case kind")
