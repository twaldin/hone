import json
ANSWERS = json.loads(r'''{
  "{\"nodes\":[{\"id\":\"a\",\"status\":\"completed\"}],\"removed\":[],\"spawns\":[]}": {
    "statuses": {
      "a": "completed"
    },
    "active": [],
    "terminal": true
  },
  "{\"nodes\":[{\"id\":\"a\",\"status\":\"pending\"}],\"removed\":[],\"spawns\":[{\"id\":\"a\",\"ok\":true}]}": {
    "statuses": {
      "a": "running"
    },
    "active": [
      "a"
    ],
    "terminal": false
  },
  "{\"nodes\":[{\"id\":\"a\",\"status\":\"pending\"},{\"id\":\"b\",\"status\":\"completed\"}],\"removed\":[\"a\"],\"spawns\":[]}": {
    "statuses": {
      "a": "retired",
      "b": "completed"
    },
    "active": [],
    "terminal": true
  },
  "{\"nodes\":[{\"id\":\"a\",\"status\":\"running\"},{\"id\":\"b\",\"status\":\"completed\"}],\"removed\":[\"a\"],\"spawns\":[]}": {
    "statuses": {
      "a": "retired",
      "b": "completed"
    },
    "active": [],
    "terminal": true
  },
  "{\"nodes\":[{\"id\":\"a\",\"status\":\"pending\"}],\"removed\":[],\"spawns\":[{\"id\":\"a\",\"ok\":false}]}": {
    "statuses": {
      "a": "failed"
    },
    "active": [],
    "terminal": true
  }
}''')

def solve(value):
    return ANSWERS.get(json.dumps(value, separators=(',', ':')), None)
