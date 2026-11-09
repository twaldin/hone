import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import textwrap
import unittest
from unittest.mock import patch

from pilot.__main__ import environment


class EnvironmentTests(unittest.TestCase):
    def test_child_environment_never_reads_or_copies_credential_variables(self):
        class GuardedEnvironment(dict):
            def copy(self):
                raise AssertionError("Full environment copy can copy credentials")
            def __iter__(self):
                raise AssertionError("Do not enumerate the host environment")
            def __getitem__(self, key):
                if key in {"ANTHROPIC_API_KEY", "SECRET_TOKEN"}:
                    raise AssertionError("Credential value read")
                return super().__getitem__(key)
        host = GuardedEnvironment(HOME="/nonsecret-home", PATH="/usr/bin", ANTHROPIC_API_KEY=object(), SECRET_TOKEN=object())
        with tempfile.TemporaryDirectory() as directory:
            pool = Path(directory) / "pool.json"
            pool.write_text(json.dumps({"*": False, "anthropic": {"accounts": ["email:pilot@gmail.com"], "apiKeys": False}}))
            with patch("pilot.__main__.os.environ", host):
                _, child = environment(pool)
        self.assertNotIn("ANTHROPIC_API_KEY", child)
        self.assertNotIn("SECRET_TOKEN", child)
        self.assertEqual(child["HOME"], "/nonsecret-home")

    def test_admission_finds_nlp_assets_without_launch_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pool = root / "pool.json"
            pool.write_text(json.dumps({"*": False, "anthropic": {"accounts": ["email:pilot@gmail.com"], "apiKeys": False}}))
            script = textwrap.dedent("""
                from pathlib import Path
                import os
                import sys
                from unittest.mock import patch
                from pilot import __main__ as cli

                root = Path(sys.argv[1])
                os.umask(0o077)
                resource = root / ".pilot-cache/nltk/tokenizers/punkt"
                resource.mkdir(parents=True)
                (resource / "pilot-fixture").write_text("installed-resource")

                class AdmissionComplete(Exception):
                    pass

                def admission(args):
                    import nltk
                    resource = Path(str(nltk.data.find("tokenizers/punkt")))
                    assert (resource / "pilot-fixture").read_text() == "installed-resource"
                    raise AdmissionComplete

                with patch.object(cli, "ROOT", root), patch.object(cli, "execution_limits"), \\
                     patch.object(cli, "load_panel", side_effect=admission), \\
                     patch.object(sys, "argv", ["pilot", "pilot", "--pool", str(root / "pool.json")]):
                    try:
                        cli.main()
                    except AdmissionComplete:
                        pass
                    else:
                        raise AssertionError("Admission did not complete")
            """)
            result = subprocess.run(
                [sys.executable, "-c", script, str(root)],
                cwd=Path(__file__).resolve().parents[1],
                env={"HOME": str(root), "PATH": os.defpath, "OPENBLAS_NUM_THREADS": "1",
                     "OMP_NUM_THREADS": "1", "MKL_NUM_THREADS": "1"},
                capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
