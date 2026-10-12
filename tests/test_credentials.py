import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from helpers import dc


class CredentialRule(unittest.TestCase):
    """Environment first, then INCUTEC_CREDENTIALS_FILE; a repo .env or notion_token is never read."""

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        self.file = self.dir / "credentials.env"
        home = self.dir / "home"
        (home / ".config/incutec").mkdir(parents=True)
        (home / ".config/incutec/credentials.env").write_text("OPENDRONE_DISCORD_BOT_TOKEN=default-file\n")
        (home / ".config/incutec/resources.env").write_text("OPENDRONE_DISCORD_BOT_TOKEN=decoy\n")
        (home / ".config/incutec/notion_token").write_text("decoy\n")
        (self.dir / ".env").write_text("OPENDRONE_DISCORD_BOT_TOKEN=decoy\n")
        base = {"HOME": str(home), "PATH": os.environ.get("PATH", ""), "INCUTEC_CREDENTIALS_FILE": str(self.file)}
        patcher = mock.patch.dict(os.environ, base, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        cwd = os.getcwd()
        os.chdir(self.dir)
        self.addCleanup(os.chdir, cwd)

    def test_environment_wins(self):
        self.file.write_text("OPENDRONE_DISCORD_BOT_TOKEN=from-file\n")
        os.environ["OPENDRONE_DISCORD_BOT_TOKEN"] = "from-env"
        self.assertEqual(dc.token(), "from-env")

    def test_then_the_file_named_by_incutec_credentials_file(self):
        self.file.write_text("OTHER=1\nexport OPENDRONE_DISCORD_BOT_TOKEN='from-file'\n")
        self.assertEqual(dc.token(), "from-file")

    def test_default_path_when_unset(self):
        del os.environ["INCUTEC_CREDENTIALS_FILE"]
        self.assertEqual(dc.token(), "default-file")

    def test_other_files_are_ignored_and_the_error_names_credentials_env(self):
        self.file.write_text("OTHER=1\n")
        with self.assertRaises(dc.ConfigError) as ctx:
            dc.token()
        self.assertIn(str(self.file), str(ctx.exception))
        self.assertNotIn("decoy", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
