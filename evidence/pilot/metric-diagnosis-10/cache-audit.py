import ast
import hashlib
import json
from pathlib import Path
import struct

root = Path('/home/tim/worktrees/hone/hone-hone-pilot-seeds12-1/.pilot-cache/hover-retrieval')
receipt = json.loads((root / 'index-receipt.json').read_text())
expected = {root / 'wiki.abstracts.2017.tar.gz': receipt['corpus_archive_sha256'],
            root / 'wiki.abstracts.2017.jsonl': receipt['corpus_sha256']}
expected.update({root / 'bm25s_retriever' / name: digest for name, digest in receipt['index_sha256'].items()})
results = []
for path, digest in expected.items():
    hasher = hashlib.sha256()
    with path.open('rb') as stream:
        while chunk := stream.read(4 * 1024 * 1024):
            hasher.update(chunk)
    assert hasher.hexdigest() == digest, str(path)
    row = {'file': str(path.relative_to(root)), 'sha256': hasher.hexdigest(), 'bytes': path.stat().st_size}
    if path.suffix == '.json':
        value = json.loads(path.read_text())
        row['json_parse'] = 'passed'
        row['json_type'] = type(value).__name__
    if path.suffix == '.npy':
        with path.open('rb') as stream:
            assert stream.read(6) == b'\x93NUMPY'
            version = tuple(stream.read(2))
            width, fmt = (2, '<H') if version == (1, 0) else (4, '<I')
            size = struct.unpack(fmt, stream.read(width))[0]
            header = ast.literal_eval(stream.read(size).decode().strip())
            offset = stream.tell()
        elements = 1
        for count in header['shape']:
            elements *= count
        itemsize = int(header['descr'][2:])
        assert offset + elements * itemsize == path.stat().st_size
        row['npy_header_and_size'] = 'passed'
    results.append(row)
print(json.dumps({'admitted_hashes_match': True, 'files': results, 'rebuilt_index': False, 'model_calls': 0}, indent=2))
