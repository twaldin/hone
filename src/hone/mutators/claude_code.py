"""Claude Code CLI mutator — shells out to `claude -p` using the user's subscription.

.. deprecated::
    Use ``HarnessMutator(harness_name="claude-code")`` (``--mutator harness:claude-code:sonnet``)
    instead. This class duplicates subprocess plumbing that the harness library handles
    more robustly and will be removed in a future release.
"""
from __future__ import annotations

import json
import subprocess
import warnings

from hone.mutators.base import Mutator, MutatorError, MutatorResult


class ClaudeCodeMutator(Mutator):
    """Invoke Claude Code as a subprocess.

    .. deprecated::
        Use :class:`~hone.mutators.harness_mutator.HarnessMutator` with
        ``harness_name="claude-code"`` (CLI: ``--mutator harness:claude-code:sonnet``).
        This class will be removed in a future release.

    Assumes the user has `claude` on PATH and is logged in (via Claude Pro
    subscription or ANTHROPIC_API_KEY). We use `--output-format json` to get
    structured output with token/cost info.
    """

    name = "claude-code"

    DEFAULT_MODEL = "sonnet"
    TIMEOUT_SECONDS = 300

    def __init__(self, model: str | None = None) -> None:
        warnings.warn(
            "ClaudeCodeMutator is deprecated and will be removed in a future release. "
            "Use HarnessMutator instead: --mutator harness:claude-code:sonnet",
            DeprecationWarning,
            stacklevel=2,
        )
        super().__init__(model=model)

    def propose(self, mutator_prompt: str) -> MutatorResult:
        model = self.model or self.DEFAULT_MODEL
        cmd = [
            "claude",
            "-p",
            mutator_prompt,
            "--model",
            model,
            "--output-format",
            "json",
            "--dangerously-skip-permissions",
        ]

        try:
            proc = subprocess.run(  # noqa: S603 — cmd is constructed, no shell
                cmd,
                capture_output=True,
                text=True,
                timeout=self.TIMEOUT_SECONDS,
                check=False,
            )
        except FileNotFoundError as e:
            raise MutatorError(
                "claude CLI not found on PATH. Install from "
                "https://docs.anthropic.com/claude/docs/claude-code"
            ) from e
        except subprocess.TimeoutExpired as e:
            raise MutatorError(f"claude -p timed out after {self.TIMEOUT_SECONDS}s") from e

        if proc.returncode != 0:
            raise MutatorError(
                f"claude -p exited {proc.returncode}: {proc.stderr.strip()[:500]}"
            )

        # Parse the JSON envelope
        try:
            envelope = json.loads(proc.stdout)
        except json.JSONDecodeError as e:
            raise MutatorError(
                f"claude -p did not return valid JSON: {proc.stdout[:200]}"
            ) from e

        # Claude Code JSON format: { "type": "result", "result": "...", "usage": {...}, "total_cost_usd": ... }
        if envelope.get("type") == "result":
            text = envelope.get("result", "")
        else:
            # Older format or unexpected shape — treat whole stdout as the response.
            text = envelope.get("result") or envelope.get("text") or proc.stdout

        if not text.strip():
            raise MutatorError("claude -p returned empty result")

        usage = envelope.get("usage") or {}
        tokens_in = _safe_int(usage.get("input_tokens")) + _safe_int(usage.get("cache_read_input_tokens")) + _safe_int(usage.get("cache_creation_input_tokens"))
        tokens_out = _safe_int(usage.get("output_tokens"))
        cost_usd = envelope.get("total_cost_usd")

        return MutatorResult(
            new_prompt=text,
            tokens_in=tokens_in or None,
            tokens_out=tokens_out or None,
            cost_usd=float(cost_usd) if cost_usd is not None else None,
            raw_response=proc.stdout,
        )


def _safe_int(v: object) -> int:
    try:
        return int(v)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0
