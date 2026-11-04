import json
from pathlib import Path
import tempfile
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


if __name__ == "__main__":
    unittest.main()
