"""Custom script mutator — shell out to a user-provided script."""
from __future__ import annotations

import subprocess
from pathlib import Path

from hone.mutators.base import Mutator, MutatorError, MutatorResult


class CustomScriptMutator(Mutator):
    """Invoke a user script.

    Contract:
        $ ./user-script.sh <mutator_prompt_file>
    The script reads the mutator prompt from the file path arg, writes the new
    prompt to stdout. Cost/tokens are unknown (left as None).
    """

    name = "custom-script"
    TIMEOUT_SECONDS = 300

    def __init__(self, script_path: str, model: str | None = None) -> None:
        super().__init__(model=model)
        self.script_path = Path(script_path).expanduser().resolve()
        if not self.script_path.exists():
            raise MutatorError(f"Mutator script not found: {self.script_path}")

    def propose(self, mutator_prompt: str) -> MutatorResult:
        import tempfile

        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".prompt", delete=False, encoding="utf-8"
        ) as f:
            f.write(mutator_prompt)
            prompt_file = f.name

        try:
            proc = subprocess.run(  # noqa: S603
                [str(self.script_path), prompt_file],
                capture_output=True,
                text=True,
                timeout=self.TIMEOUT_SECONDS,
                check=False,
            )
        except subprocess.TimeoutExpired as e:
            raise MutatorError(f"{self.script_path.name} timed out") from e
        finally:
            Path(prompt_file).unlink(missing_ok=True)

        if proc.returncode != 0:
            raise MutatorError(
                f"{self.script_path.name} exited {proc.returncode}: {proc.stderr.strip()[:500]}"
            )
        if not proc.stdout.strip():
            raise MutatorError(f"{self.script_path.name} returned empty stdout")

        return MutatorResult(
            new_prompt=proc.stdout,
            raw_response=proc.stdout,
        )
