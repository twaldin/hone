import re

ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


def solve(value):
    if value["kind"] == "readiness":
        verdicts = []
        for event in value["events"]:
            lines = ANSI_RE.sub("", event["pane"]).split("\n")
            verdicts.append("ready" if any(line.strip() in (">", "❯") for line in lines) else "loading")
        return {"verdicts": verdicts}

    workdir = value["workdir"]
    filename = value["filename"]
    content = value["content"]
    options = value.get("options", {})
    backup = options.get("backup", True)
    files = dict(value.get("filesystem", {}))
    backup_name = ".harness-backup-" + filename
    existed_before = filename in files
    wrote_backup = False
    if existed_before:
        existing = files[filename]
        if backup:
            files[backup_name] = existing
            wrote_backup = True
        files[filename] = content + "\n"
    else:
        files[filename] = content + "\n"
    after_write = dict(sorted(files.items()))
    if wrote_backup:
        files[filename] = files.pop(backup_name)
    elif not existed_before:
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
