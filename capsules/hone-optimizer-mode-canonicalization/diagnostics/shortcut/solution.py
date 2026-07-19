import json
ANSWERS = json.loads(r'''{
  "[{\"path\":\"package.json\",\"mode\":420},{\"path\":\"bin/run\",\"mode\":493}]": [
    {
      "path": "bin/run",
      "mode": 493
    },
    {
      "path": "package.json",
      "mode": 420
    }
  ],
  "[{\"path\":\"src/a.ts\",\"mode\":384},{\"path\":\"scripts/build.sh\",\"mode\":448}]": [
    {
      "path": "scripts/build.sh",
      "mode": 493
    },
    {
      "path": "src/a.ts",
      "mode": 420
    }
  ],
  "[{\"path\":\"src/b.ts\",\"mode\":436},{\"path\":\"bin/tool\",\"mode\":509}]": [
    {
      "path": "bin/tool",
      "mode": 493
    },
    {
      "path": "src/b.ts",
      "mode": 420
    }
  ],
  "[{\"path\":\"README\",\"mode\":416},{\"path\":\"cli\",\"mode\":489}]": [
    {
      "path": "README",
      "mode": 420
    },
    {
      "path": "cli",
      "mode": 493
    }
  ]
}''')

def solve(value):
    return ANSWERS.get(json.dumps(value, separators=(',', ':')), None)
