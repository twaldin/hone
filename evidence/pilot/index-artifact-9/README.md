# Predeclaration 9 evidence: admitted retrieval artifact

The owner authorized resuming the six-cell seed-0 development pilot by reusing the exact HoVer index that passed admission. This addendum records artifact handling and a reproducibility limit. It does not change the committed matrix, budgets, selection metric, bootstrap, practical threshold or stop rules in predeclaration 9.

## Verified artifact and copy

The admitted source is `/home/tim/worktrees/hone/hone-hone-pilot-harness-1/.pilot-cache/hover-retrieval`. It was read only. Every one of its eight files was hashed before copying. The source receipt equals `controls-7b/cohorts.json`'s frozen retrieval receipt. All five index hashes, including the four that differed in the fresh rebuild, and both corpus hashes match admission exactly.

[Source verification](source-verification.json) records the eight SHA-256 values and sizes. Their total is 3,508,125,241 bytes. The copy used:

```sh
nice -n 10 taskset -c 6 cp -a /home/tim/worktrees/hone/hone-hone-pilot-harness-1/.pilot-cache/hover-retrieval/. .pilot-cache/hover-retrieval/
```

Every copied file was hashed again. [Copy verification](copy-verification.json) records an identical eight-file inventory, sizes and hashes. The harness's existing `.pilot-cache` path therefore resolves to this lane's verified copy, never the source directory. No source artifact, receipt, model route, account pool, broker configuration or BM25S code was modified. These checks made zero model calls and read no final-test labels.

The unchanged [admission entrypoint passed](admission.json) on this copy, selecting MBPP + HoVer at CPU 6 and nice 10. It took 471.88 seconds, made zero model calls and reported no final-test labels loaded. No controls were rerun and no gate was relaxed.

## Known limit: reuse, do not rebuild

The [earlier fresh-build failure](../seed0-9/preflight-stop.json) remains unchanged. The same corpus, extracted corpus bytes, dependency versions, document count, retrieval recipe and `params.index.json` did not produce a byte-identical index. These files differed:

- `bm25s_retriever/data.csc.index.npy`.
- `bm25s_retriever/indices.csc.index.npy`.
- `bm25s_retriever/indptr.csc.index.npy`.
- `bm25s_retriever/vocab.index.json`.

The source of BM25S 0.2.12 provides a likely ordering cause. With stemming enabled, `tokenization.py:675-676` builds `vocab = set(tokens_stemmed)` and enumerates that set to assign IDs. A toy tokenization under `PYTHONHASHSEED=1` and `2` produced the same stem set but different token IDs. [The ordering record](rebuild-limit.json) preserves the source hash and both observed vocabularies.

This is evidence of hash-seed-sensitive vocabulary numbering, not proof that it explains every byte of the full-index mismatch. No full index was rebuilt for this diagnosis. No semantic retrieval-equivalence claim is made, and the exact admission gate stays unchanged.

**Future admitted reruns must reuse the admitted index artifact, not rebuild it from the same corpus, versions and recipe.** Verify every source file and the admitted index hashes before copying, then hash the copy again. A source or copy mismatch stops the run and requires another owner ruling. Do not fix BM25S, rebuild or re-admit under this task.

## Replay without labels or models

With the preserved admitted source and this lane's copy present, recompute each manifest entry using `sha256sum` and compare it with the recorded value. The receipt supplies the admitted expectations for both corpus files and every index file. The manifests retain the receipt file's own hash too. This checks actual bytes, not just receipt metadata.

The toy diagnosis uses only authored text and the frozen tokenizer. It calls neither `BM25.index` nor any model. Artifact hashing and toy tokenization are setup evidence, not optimizer performance or search spend. Both historical preflight stops remain valid records; the owner's new ruling authorizes this verified-artifact continuation.
