"""Release versioning and source selection, without requiring a local signing key."""
import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import zipfile
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parents[1]


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='f1tv-release-test-')
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        (self.repo / 'scripts').mkdir()
        for name in ['build-release.sh', 'draft-release.sh']:
            source = ROOT / 'scripts' / name
            if source.exists():
                shutil.copy2(source, self.repo / 'scripts' / name)
        (self.repo / 'app/js').mkdir(parents=True)
        shutil.copy2(ROOT / 'app/config.xml', self.repo / 'app/config.xml')
        (self.repo / 'app/js/updates.js').write_text("var REPO = 'YOUR-GITHUB-USER/f1tv-tizen';\n")
        (self.repo / 'app/index.html').write_text('tagged app')
        (self.repo / 'README.md').write_text('https://github.com/YOUR-GITHUB-USER/f1tv-tizen\n')
        (self.repo / '.gitignore').write_text('build/\nlocal/\n')
        # Only the external Tizen package operation is replaced. Its input becomes a real zip.
        (self.repo / 'scripts/deploy.sh').write_text('''#!/usr/bin/env bash
set -eu
test "$1" = build
test "$RELEASE" = 1
test -n "$APP_SRC"
touch packager-called
mkdir -p build
python3 - <<'PY'
import os
from pathlib import Path
import zipfile
source = Path(os.environ['APP_SRC'])
with zipfile.ZipFile('build/F1TV.wgt', 'w') as package:
    for path in source.rglob('*'):
        if path.is_file():
            package.write(path, path.relative_to(source))
PY
''')
        (self.repo / 'scripts/deploy.sh').chmod(0o755)
        self.git('init', '-q')
        self.git('config', 'user.name', 'Release Test')
        self.git('config', 'user.email', 'release@example.invalid')
        self.git('remote', 'add', 'origin', 'https://github.com/example/f1tv-tizen.git')
        self.git('add', '.')
        self.git('commit', '-qm', 'Initial')

    def run_command(self, *args):
        return subprocess.run(args, cwd=self.repo, text=True, capture_output=True,
                              env={**os.environ, 'TIZEN_HOME': '/nonexistent-sdk',
                                   'GIT_CONFIG_GLOBAL': '/dev/null'})

    def git(self, *args):
        result = self.run_command('git', *args)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()

    def script(self, name, *args):
        return self.run_command('bash', 'scripts/' + name, *args)

    def tag(self, name='v0.1.0'):
        self.git('tag', name)

    def test_build_uses_tag_version_without_modifying_or_committing_source(self):
        self.tag('v0.2.0')
        original = (self.repo / 'app/config.xml').read_bytes()
        commit = self.git('rev-parse', 'HEAD')
        result = self.script('build-release.sh', 'v0.2.0')
        self.assertEqual(result.returncode, 0, result.stderr)
        with zipfile.ZipFile(self.repo / 'build/F1TV.wgt') as archive:
            manifest = ET.fromstring(archive.read('config.xml'))
            self.assertEqual(manifest.attrib['version'], '0.2.0')
            self.assertEqual(manifest.tag, '{http://www.w3.org/ns/widgets}widget')
            self.assertIsNotNone(manifest.find('{http://tizen.org/ns/widgets}application'))
        self.assertEqual((self.repo / 'app/config.xml').read_bytes(), original)
        self.assertEqual(self.git('rev-parse', 'HEAD'), commit)
        self.assertEqual(self.git('rev-parse', 'v0.2.0^{commit}'), commit)

    def test_build_packages_only_tagged_files_and_writes_valid_checksum(self):
        self.tag()
        (self.repo / 'app/index.html').write_text('dirty working copy')
        (self.repo / 'app/private.txt').write_text('untracked')
        (self.repo / 'local').mkdir()
        (self.repo / 'local/logo.png').write_text('personal override')
        result = self.script('build-release.sh', 'v0.1.0')
        self.assertEqual(result.returncode, 0, result.stderr)
        package = self.repo / 'build/F1TV.wgt'
        with zipfile.ZipFile(package) as archive:
            self.assertEqual(archive.read('index.html'), b'tagged app')
            self.assertNotIn('private.txt', archive.namelist())
            self.assertNotIn('local/logo.png', archive.namelist())
        checksum = (self.repo / 'build/F1TV.wgt.sha256').read_text().split()
        self.assertEqual(checksum, [hashlib.sha256(package.read_bytes()).hexdigest(), 'F1TV.wgt'])

    def test_check_mode_validates_without_packaging(self):
        self.tag()
        result = self.script('build-release.sh', 'v0.1.0', '--check')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.repo / 'packager-called').exists())

    def test_check_mode_accepts_tag_without_matching_source_version(self):
        self.tag('v0.2.0')
        original = (self.repo / 'app/config.xml').read_bytes()
        result = self.script('build-release.sh', 'v0.2.0', '--check')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.repo / 'packager-called').exists())
        self.assertEqual((self.repo / 'app/config.xml').read_bytes(), original)

    def test_build_refuses_missing_or_invalid_tag(self):
        for tag in ['v0.2.0', 'main', 'v1.0.0;exit 0', 'v0.1.0-beta']:
            with self.subTest(tag=tag):
                result = self.script('build-release.sh', tag)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((self.repo / 'packager-called').exists())

    def draft(self, state):
        (self.repo / 'build').mkdir()
        (self.repo / 'build/F1TV.wgt').write_text('signed package')
        (self.repo / 'build/F1TV.wgt.sha256').write_text('checksum')
        tools = self.repo / 'test-bin'
        tools.mkdir()
        # GitHub is external; record requests and emulate only release lookup.
        (tools / 'gh').write_text('''#!/usr/bin/env python3
import json, os, sys
with open('gh-calls.jsonl', 'a') as log:
    log.write(json.dumps(sys.argv[1:]) + '\\n')
if sys.argv[1:3] == ['release', 'view']:
    state = os.environ['RELEASE_STATE']
    if state == 'missing':
        sys.exit(1)
    print(state)
''')
        (tools / 'gh').chmod(0o755)
        return subprocess.run(['bash', 'scripts/draft-release.sh', 'v0.1.0'], cwd=self.repo,
                              text=True, capture_output=True,
                              env={**os.environ, 'PATH': str(tools) + os.pathsep + os.environ['PATH'],
                                   'GH_REPO': 'example/f1tv-tizen', 'RELEASE_STATE': state})

    def gh_calls(self):
        import json
        return [json.loads(line) for line in (self.repo / 'gh-calls.jsonl').read_text().splitlines()]

    def test_new_release_is_a_draft_with_both_assets(self):
        result = self.draft('missing')
        self.assertEqual(result.returncode, 0, result.stderr)
        create = self.gh_calls()[-1]
        self.assertEqual(create[:3], ['release', 'create', 'v0.1.0'])
        self.assertIn('--draft', create)
        self.assertIn('--verify-tag', create)
        self.assertIn('build/F1TV.wgt', create)
        self.assertIn('build/F1TV.wgt.sha256', create)

    def test_retry_updates_only_draft_assets(self):
        result = self.draft('true')
        self.assertEqual(result.returncode, 0, result.stderr)
        upload = self.gh_calls()[-1]
        self.assertEqual(upload[:3], ['release', 'upload', 'v0.1.0'])
        self.assertIn('--clobber', upload)

    def test_retry_refuses_published_release(self):
        result = self.draft('false')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('published', result.stderr)
        self.assertEqual(len(self.gh_calls()), 1)


if __name__ == '__main__':
    unittest.main()
