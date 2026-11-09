# Predeclaration 11 archive-derived tables

Twelve cells were attempted. Eleven completed at declared caps. MBPP/seed-2/GEPA is an unscored infrastructure failure. N/A is unavailable, never zero-filled or renormalized.

All intervals describe adaptive development selection. They are not confirmatory evidence of optimizer superiority. Seed 0 is historical and never pooled with seeds 1 and 2. Values are percentages or percentage points as labeled.

## Primary cells, seeds 1 and 2

| Seed | Task | Method | Status | Baseline % | Chosen % | Delta pp | 95% CI pp |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | mbpp | hone | completed | 75.56 | 80.00 | 4.44 | [0.00, 10.00] |
| 1 | mbpp | gepa | completed | 76.67 | 80.00 | 3.33 | [-1.11, 8.89] |
| 1 | mbpp | plain | completed | 76.67 | 80.00 | 3.33 | [-1.11, 8.89] |
| 1 | hover | hone | completed | 28.67 | 61.33 | 32.67 | [26.67, 38.67] |
| 1 | hover | gepa | completed | 31.33 | 43.67 | 12.33 | [7.33, 17.33] |
| 1 | hover | plain | completed | 30.33 | 30.33 | 0.00 | [0.00, 0.00] |
| 2 | mbpp | hone | completed | 75.56 | 75.56 | 0.00 | [0.00, 0.00] |
| 2 | mbpp | gepa | infrastructure_failure | N/A | N/A | N/A | N/A |
| 2 | mbpp | plain | completed | 75.56 | 82.22 | 6.67 | [1.11, 13.33] |
| 2 | hover | hone | completed | 29.00 | 29.00 | 0.00 | [0.00, 0.00] |
| 2 | hover | gepa | completed | 31.00 | 37.33 | 6.33 | [1.67, 11.00] |
| 2 | hover | plain | completed | 28.67 | 28.67 | 0.00 | [0.00, 0.00] |

## Per-seed methods and primary aggregation

| Measurement | Method | Baseline % | Chosen % | Delta pp | 95% CI pp |
| --- | --- | --- | --- | --- | --- |
| PD11 seeds 1 and 2 | hone | 52.19 | 61.47 | 9.28 | [0.00, 25.75] |
| PD11 seeds 1 and 2 | gepa | N/A | N/A | N/A | N/A |
| PD11 seeds 1 and 2 | plain | 52.81 | 55.31 | 2.50 | [0.00, 6.94] |
| PD11 seed 1 | hone | 52.11 | 70.67 | 18.56 | [2.22, 35.50] |
| PD11 seed 1 | gepa | 54.00 | 61.83 | 7.83 | [1.11, 14.67] |
| PD11 seed 1 | plain | 53.50 | 55.17 | 1.67 | [-0.56, 5.56] |
| PD11 seed 2 | hone | 52.28 | 52.28 | 0.00 | [0.00, 0.00] |
| PD11 seed 2 | gepa | N/A | N/A | N/A | N/A |
| PD11 seed 2 | plain | 52.11 | 55.44 | 3.33 | [0.00, 9.44] |
| PD9 seed 0, separate | hone | 52.78 | 55.00 | 2.22 | [0.00, 7.22] |
| PD9 seed 0, separate | gepa | 54.06 | 62.67 | 8.61 | [-1.11, 17.67] |
| PD9 seed 0, separate | plain | 54.00 | 56.22 | 2.22 | [0.00, 6.67] |

Intervals use equal seed and task weighting, 10,000 MT19937 replicates, seed 20261109, and type-7 endpoints. GEPA's primary aggregate is unavailable because MBPP/seed-2/GEPA failed.

## Per-task aggregation across seeds 1 and 2

| Task | Method | Paired seeds | Baseline % | Chosen % | Delta pp | 95% CI pp |
| --- | --- | --- | --- | --- | --- | --- |
| mbpp | hone | 1, 2 | 75.56 | 77.78 | 2.22 | [0.00, 7.22] |
| hover | hone | 1, 2 | 28.83 | 45.17 | 16.33 | [0.00, 35.50] |
| mbpp | gepa | 1 | N/A | N/A | N/A | N/A |
| hover | gepa | 1, 2 | 31.17 | 40.50 | 9.33 | [4.17, 14.67] |
| mbpp | plain | 1, 2 | 76.11 | 81.11 | 5.00 | [1.11, 9.44] |
| hover | plain | 1, 2 | 29.50 | 29.50 | 0.00 | [0.00, 0.00] |

## Selection reuse and missing gate-passers

| Seed | Task | Method | Repeated selection evaluations | Count status | Gate-passers without complete selection | Gate status | Missing-gate evidence and reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | mbpp | hone | 0 | exact_archived_count | 0 | archived_trajectory | None |
| 1 | mbpp | gepa | 1 | exact_archived_count | N/A | not_applicable | N/A |
| 1 | mbpp | plain | 0 | exact_archived_count | N/A | not_applicable | N/A |
| 1 | hover | hone | 0 | exact_archived_count | 0 | archived_trajectory | None |
| 1 | hover | gepa | 0 | exact_archived_count | N/A | not_applicable | N/A |
| 1 | hover | plain | 0 | exact_archived_count | N/A | not_applicable | N/A |
| 2 | mbpp | hone | 0 | exact_archived_count | 0 | archived_trajectory | None |
| 2 | mbpp | gepa | 0 | exact_archived_count | N/A | not_applicable | N/A |
| 2 | mbpp | plain | 0 | exact_archived_count | N/A | not_applicable | N/A |
| 2 | hover | hone | 0 | exact_archived_count | 0 | archived_trajectory | None |
| 2 | hover | gepa | 0 | exact_archived_count | N/A | not_applicable | N/A |
| 2 | hover | plain | 0 | exact_archived_count | N/A | not_applicable | N/A |

All Hone and plain cells have zero archived repeated selection evaluations. Unchanged MBPP/seed-1/GEPA has one. The failed GEPA cell has no terminal search.json, which remains absent and is flagged by the reporter.

## Fresh selection tails

| Seed | Task | Method | Artifact | Observed tail calls | Reason |
| --- | --- | --- | --- | --- | --- |
| 1 | mbpp | plain | sha256:fdc3cecedf61e4f19b88daba714577b2059e2b26834165746e7795dc3f4c9d70 | 10 | started_without_evaluation_record |
| 1 | hover | plain | sha256:c7985ca788392d4f814a3b688c8c4b4f533fac86e0f3bb66846deddaa4dc3024 | 1118 | started_without_evaluation_record |
| 2 | mbpp | plain | sha256:cbbd06a3523f7285b76095758aef10d65b76114fdd9e4642bd13cfe725a62f78 | 10 | started_without_evaluation_record |
| 2 | hover | plain | sha256:6fb7c7332561734e89b19d6d9b8a48d0a378ce59c4d556f013acf0c7b68167a6 | 1098 | started_without_evaluation_record |

These are incomplete vectors, not zero scores. They remain charged and do not become eligible selections. The raw result records retain the binding cap or infrastructure failure.

## Usage and error counters

| Seed | Task | Method | Calls | Reported tokens | Estimated tokens | Reported $equivalent | Refusals | Hidden attempts | Missing usage calls |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | mbpp | hone | 3392 | 1087314 | 0 | 6.227814 | 0 | 10 | 1 |
| 1 | mbpp | gepa | 3141 | 1897207 | 0 | 8.276565 | 0 | 0 | 0 |
| 1 | mbpp | plain | 2836 | 1425382 | 0 | 6.835578 | 0 | 0 | 0 |
| 1 | hover | hone | 2544 | 2059809 | 0 | 9.356115 | 0 | 0 | 0 |
| 1 | hover | gepa | 2539 | 2027167 | 0 | 8.672913 | 0 | 0 | 0 |
| 1 | hover | plain | 2475 | 2242223 | 0 | 9.895509 | 0 | 0 | 0 |
| 2 | mbpp | hone | 3084 | 924767 | 0 | 5.552517 | 0 | 0 | 0 |
| 2 | mbpp | gepa | 361 | 131718 | 0 | 0.679938 | 0 | 0 | 0 |
| 2 | mbpp | plain | 2980 | 1602234 | 0 | 7.611186 | 0 | 0 | 0 |
| 2 | hover | hone | 1863 | 2377318 | 0 | 9.168738 | 0 | 0 | 0 |
| 2 | hover | gepa | 2615 | 2127562 | 0 | 9.084114 | 0 | 0 | 0 |
| 2 | hover | plain | 2455 | 2219956 | 0 | 9.890916 | 0 | 0 | 0 |

Reported cost-equivalent is not an invoice. One provider call lacks reported usage, and internal failed-attempt usage remains unknown. Conservative estimates are not reported usage.

## Per-cell phase spend

| Seed | Task | Method | Phase | Calls | Reported tokens | Reported $equivalent |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | mbpp | hone | proposal | 134 | 462251 | 1.826109 |
| 1 | mbpp | hone | selection_evaluation | 450 | 101526 | 0.658350 |
| 1 | mbpp | hone | training_evaluation | 2801 | 522268 | 3.733056 |
| 1 | mbpp | hone | unassigned | 7 | 1269 | 0.010299 |
| 1 | mbpp | gepa | proposal | 107 | 764133 | 2.690115 |
| 1 | mbpp | gepa | selection_evaluation | 1710 | 653513 | 3.222363 |
| 1 | mbpp | gepa | training_evaluation | 1320 | 478118 | 2.356710 |
| 1 | mbpp | gepa | unassigned | 4 | 1443 | 0.007377 |
| 1 | mbpp | plain | proposal | 104 | 575826 | 2.245542 |
| 1 | mbpp | plain | selection_evaluation | 1890 | 603074 | 3.205362 |
| 1 | mbpp | plain | training_evaluation | 832 | 242708 | 1.362816 |
| 1 | mbpp | plain | unassigned | 10 | 3774 | 0.021858 |
| 1 | hover | hone | proposal | 4 | 145522 | 0.458010 |
| 1 | hover | hone | selection_evaluation | 2380 | 1797285 | 8.365095 |
| 1 | hover | hone | training_evaluation | 160 | 117002 | 0.533010 |
| 1 | hover | hone | unassigned | 0 | 0 | 0.000000 |
| 1 | hover | gepa | proposal | 2 | 178476 | 0.544524 |
| 1 | hover | gepa | selection_evaluation | 2383 | 1738027 | 7.649229 |
| 1 | hover | gepa | training_evaluation | 154 | 110664 | 0.479160 |
| 1 | hover | gepa | unassigned | 0 | 0 | 0.000000 |
| 1 | hover | plain | proposal | 5 | 365425 | 1.126359 |
| 1 | hover | plain | selection_evaluation | 1192 | 809753 | 3.686091 |
| 1 | hover | plain | training_evaluation | 160 | 107165 | 0.473415 |
| 1 | hover | plain | unassigned | 1118 | 959880 | 4.609644 |
| 2 | mbpp | hone | proposal | 126 | 415202 | 1.632714 |
| 2 | mbpp | hone | selection_evaluation | 450 | 96233 | 0.645915 |
| 2 | mbpp | hone | training_evaluation | 2504 | 412774 | 3.269322 |
| 2 | mbpp | hone | unassigned | 4 | 558 | 0.004566 |
| 2 | mbpp | gepa | proposal | 13 | 70604 | 0.225948 |
| 2 | mbpp | gepa | selection_evaluation | 180 | 33192 | 0.246024 |
| 2 | mbpp | gepa | training_evaluation | 160 | 25317 | 0.194559 |
| 2 | mbpp | gepa | unassigned | 8 | 2605 | 0.013407 |
| 2 | mbpp | plain | proposal | 90 | 537107 | 2.069601 |
| 2 | mbpp | plain | selection_evaluation | 2160 | 824416 | 4.219368 |
| 2 | mbpp | plain | training_evaluation | 720 | 236034 | 1.297734 |
| 2 | mbpp | plain | unassigned | 10 | 4677 | 0.024483 |
| 2 | hover | hone | proposal | 29 | 1126428 | 3.551340 |
| 2 | hover | hone | selection_evaluation | 1194 | 817605 | 3.700923 |
| 2 | hover | hone | training_evaluation | 640 | 433285 | 1.916475 |
| 2 | hover | hone | unassigned | 0 | 0 | 0.000000 |
| 2 | hover | gepa | proposal | 3 | 291643 | 0.887697 |
| 2 | hover | gepa | selection_evaluation | 2388 | 1672557 | 7.494183 |
| 2 | hover | gepa | training_evaluation | 224 | 163362 | 0.702234 |
| 2 | hover | gepa | unassigned | 0 | 0 | 0.000000 |
| 2 | hover | plain | proposal | 5 | 369548 | 1.140720 |
| 2 | hover | plain | selection_evaluation | 1192 | 820059 | 3.724221 |
| 2 | hover | plain | training_evaluation | 160 | 107655 | 0.474825 |
| 2 | hover | plain | unassigned | 1098 | 922694 | 4.551150 |

Unassigned evaluation-tail calls stay in the total and are not allocated to a fabricated completed evaluation.

## Per-cell timing and binding caps

| Seed | Task | Method | Ledger wall s | Active s | Polling s | Pause s | Pause episodes | Binding cap or stop |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | mbpp | hone | 13238.157 | 7201.141 | 5633.827 | 403.188 | 1 | active_seconds |
| 1 | mbpp | gepa | 13912.226 | 7202.639 | 6709.586 | 0.000 | 0 | active_seconds |
| 1 | mbpp | plain | 13834.839 | 7201.263 | 6381.092 | 252.484 | 1 | active_seconds |
| 1 | hover | hone | 21969.247 | 6303.227 | 4108.879 | 11557.141 | 2 | usd_reservation |
| 1 | hover | gepa | 9630.692 | 5612.201 | 4018.491 | 0.000 | 0 | usd_reservation |
| 1 | hover | plain | 11055.289 | 6333.406 | 4115.786 | 606.098 | 1 | usd_reservation |
| 2 | mbpp | hone | 11906.760 | 7200.925 | 4705.835 | 0.000 | 0 | active_seconds |
| 2 | mbpp | gepa | 1384.502 | 823.517 | 560.985 | 0.000 | 0 | GraderInfrastructureError |
| 2 | mbpp | plain | 11918.313 | 7200.230 | 4560.089 | 157.994 | 2 | active_seconds |
| 2 | hover | hone | 6829.152 | 3951.897 | 2877.255 | 0.000 | 0 | usd_reservation |
| 2 | hover | gepa | 9325.696 | 5340.199 | 3985.497 | 0.000 | 0 | usd_reservation |
| 2 | hover | plain | 9928.387 | 6128.915 | 3643.091 | 156.380 | 1 | usd_reservation |

## Historical seed 0, separate

| Seed | Task | Method | Status | Baseline % | Chosen % | Delta pp | 95% CI pp |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | mbpp | hone | completed | 75.56 | 80.00 | 4.44 | [0.00, 10.00] |
| 0 | mbpp | gepa | completed | 77.78 | 80.00 | 2.22 | [-4.44, 8.89] |
| 0 | mbpp | plain | completed | 76.67 | 81.11 | 4.44 | [1.11, 8.89] |
| 0 | hover | hone | completed | 30.00 | 30.00 | 0.00 | [0.00, 0.00] |
| 0 | hover | gepa | completed | 30.33 | 45.33 | 15.00 | [9.67, 20.67] |
| 0 | hover | plain | completed | 31.33 | 31.33 | 0.00 | [0.00, 0.00] |

These predeclaration-9 measurements retain the original last-matching-vector policy and same-artifact stochastic remeasurement caveats. See ../seed0-search-9/README.md.

### Historical usage and errors

| Seed | Task | Method | Calls | Reported tokens | Estimated tokens | Reported $equivalent | Refusals | Hidden attempts | Missing usage calls |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | mbpp | hone | 4033 | 1212737 | 0 | 7.073547 | 0 | 0 | 0 |
| 0 | mbpp | gepa | 3172 | 2362115 | 0 | 9.852441 | 0 | 0 | 0 |
| 0 | mbpp | plain | 4050 | 929268 | 0 | 6.160872 | 0 | 0 | 0 |
| 0 | hover | hone | 2708 | 2318214 | 0 | 9.897690 | 0 | 0 | 0 |
| 0 | hover | gepa | 2540 | 2012059 | 0 | 8.621001 | 0 | 0 | 0 |
| 0 | hover | plain | 1747 | 2340994 | 0 | 8.927514 | 0 | 0 | 0 |

### Historical phase spend

| Seed | Task | Method | Phase | Calls | Reported tokens | Reported $equivalent |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | mbpp | hone | proposal | 139 | 458634 | 1.851858 |
| 0 | mbpp | hone | selection_evaluation | 990 | 203404 | 1.389912 |
| 0 | mbpp | hone | training_evaluation | 2904 | 550699 | 3.831777 |
| 0 | mbpp | hone | unassigned | 0 | 0 | 0.000000 |
| 0 | mbpp | gepa | proposal | 100 | 831231 | 3.014337 |
| 0 | mbpp | gepa | selection_evaluation | 1800 | 914566 | 4.077330 |
| 0 | mbpp | gepa | training_evaluation | 1272 | 616318 | 2.760774 |
| 0 | mbpp | gepa | unassigned | 0 | 0 | 0.000000 |
| 0 | mbpp | plain | proposal | 51 | 210453 | 0.785847 |
| 0 | mbpp | plain | selection_evaluation | 3510 | 640878 | 4.772718 |
| 0 | mbpp | plain | training_evaluation | 408 | 62286 | 0.491082 |
| 0 | mbpp | plain | unassigned | 81 | 15651 | 0.111225 |
| 0 | hover | hone | proposal | 12 | 454537 | 1.445955 |
| 0 | hover | hone | selection_evaluation | 1193 | 818367 | 3.718197 |
| 0 | hover | hone | training_evaluation | 384 | 280164 | 1.259268 |
| 0 | hover | hone | unassigned | 1119 | 765146 | 3.474270 |
| 0 | hover | gepa | proposal | 2 | 198095 | 0.601593 |
| 0 | hover | gepa | selection_evaluation | 2378 | 1698477 | 7.495239 |
| 0 | hover | gepa | training_evaluation | 160 | 115487 | 0.524169 |
| 0 | hover | gepa | unassigned | 0 | 0 | 0.000000 |
| 0 | hover | plain | proposal | 16 | 1169448 | 3.625452 |
| 0 | hover | plain | selection_evaluation | 1190 | 808919 | 3.671601 |
| 0 | hover | plain | training_evaluation | 541 | 362627 | 1.630461 |
| 0 | hover | plain | unassigned | 0 | 0 | 0.000000 |

### Historical timing and caps

| Seed | Task | Method | Ledger wall s | Active s | Polling s | Pause s | Pause episodes | Binding cap or stop |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | mbpp | hone | 13512.727 | 7201.677 | 6311.050 | 0.000 | 0 | active_seconds |
| 0 | mbpp | gepa | 11275.320 | 6097.018 | 4956.361 | 221.940 | 1 | usd_reservation |
| 0 | mbpp | plain | 14058.275 | 7200.918 | 6857.357 | 0.000 | 0 | active_seconds |
| 0 | hover | hone | 10454.749 | 5998.424 | 4456.326 | 0.000 | 0 | usd_reservation |
| 0 | hover | gepa | 10386.586 | 5203.312 | 5183.274 | 0.000 | 0 | usd_reservation |
| 0 | hover | plain | 6997.751 | 3759.681 | 3238.071 | 0.000 | 0 | usd_reservation |

### Historical selection diagnostics

| Seed | Task | Method | Repeated selection evaluations | Count status | Gate-passers without complete selection | Gate status | Missing-gate evidence and reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | mbpp | hone | 5 | exact_archived_count | 0 | archived_trajectory | None |
| 0 | mbpp | gepa | 0 | exact_archived_count | N/A | not_applicable | N/A |
| 0 | mbpp | plain | 4 | exact_archived_count | N/A | not_applicable | N/A |
| 0 | hover | hone | 1 | exact_archived_count | 1 | archived_trajectory | [{"artifact_hash": "sha256:70a889a41a1a45187d03edf260ffcd5414bd8319cbcab954d52fd469a7c731c9", "binding_cap": "usd_reservation", "budget_exhaustion": "Reported-usage dollar reservation exhausted", "incomplete_evaluation_lines": [], "reason": "no_archived_complete_selection_vector", "started_tail_call_lines": [], "stop_reason": "budget_exhausted", "trajectory_lines": [6]}] |
| 0 | hover | gepa | 0 | exact_archived_count | N/A | not_applicable | N/A |
| 0 | hover | plain | 0 | exact_archived_count | N/A | not_applicable | N/A |
