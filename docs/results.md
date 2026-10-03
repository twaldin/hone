# Results and evidence

This repository holds Hone's code and docs; result bundles are not kept here. The [README](../README.md#results-so-far) summarizes the results that have retained evidence, and the evidence itself stays private where it contains sealed cases or operator records. There is no completed M2 result, and the complete evidence publisher is still unfinished.

A useful public result bundle should identify:

- The outcome and the precise claim supported, including failures and limits.
- Source, candidate, configuration and protocol digests.
- The environment and observed model routes needed to interpret the measurement.
- Reviewed aggregate measurements and links to available replay artifacts.
- Which private inputs or runtime prerequisites are unavailable publicly.

RelayBench is the planned read-only evidence surface. It should consume reviewed evidence rather than become another execution controller. Repository summaries and that surface must agree about the source revision, measurement and claim.

Keep raw operator logs, credentials, private infrastructure, terminal inputs and answers outside public bundles. A digest can identify an unavailable artifact without publishing its content; it does not make the result independently reproducible by itself. State those limits explicitly.

Historical capsule ordering or admission records are tied to their original inputs and environment. Do not relabel them as a new campaign result. Publishing run summaries and publishing a complete reproducible experiment are separate deliverables.
