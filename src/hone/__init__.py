"""hone — repository-state optimizer. v1: one core loop, git-backed state."""

from hone.gepa_faithful import (
    DEFAULT_FRONTIER_TYPE,
    GEPAResultMetadata,
    GepaTsOptimizeAnythingRunner,
    HarnessAdapterConfig,
    HarnessMutationResult,
    HarnessMutatorAdapter,
    HoneCodeCandidate,
    HoneTaskExample,
    MetricCallBudget,
    OptimizeCodeConfig,
    OptimizeCodeResult,
    TestCommandEvaluator,
    candidate_from_gepa,
    candidate_to_gepa,
    optimize_code,
)

__version__ = "1.0.0-dev"

__all__ = [
    "DEFAULT_FRONTIER_TYPE",
    "GEPAResultMetadata",
    "GepaTsOptimizeAnythingRunner",
    "HarnessAdapterConfig",
    "HarnessMutationResult",
    "HarnessMutatorAdapter",
    "HoneCodeCandidate",
    "HoneTaskExample",
    "MetricCallBudget",
    "OptimizeCodeConfig",
    "OptimizeCodeResult",
    "TestCommandEvaluator",
    "__version__",
    "candidate_from_gepa",
    "candidate_to_gepa",
    "optimize_code",
]
