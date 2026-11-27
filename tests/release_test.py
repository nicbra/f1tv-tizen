"""Release versioning, signed bundles and source selection using disposable test keys."""
import hashlib
import json
import re
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
        for name in ['build-release.sh', 'publish-release.sh', 'promote-release.sh', 'deploy.sh', 'verify-bundle.js', 'build-bundle.js', 'sign-bundle.js', 'revokes.json']:
            source = ROOT / 'scripts' / name
            if source.exists():
                shutil.copy2(source, self.repo / 'scripts' / name)
        shutil.copytree(ROOT / 'app', self.repo / 'app')
        shutil.copytree(ROOT / 'shell', self.repo / 'shell')
        import base64
        self.bundle_key = base64.b64encode(os.urandom(32)).decode()
        public = subprocess.check_output(['node', '-e',
            "const s=require('./scripts/sign-bundle'); process.stdout.write(s.publicKey(s.signingKey(process.argv[1])));",
            self.bundle_key], cwd=self.repo, text=True)
        cfg = self.repo / 'shell/config.js'
        cfg.write_text(re.sub(r"keys: \{[^}]*\}", "keys: { 'f1tv-2026': '" + public + "' }", cfg.read_text()))
        (self.repo / 'app/js/updates.js').write_text("var REPO = 'YOUR-GITHUB-USER/f1tv-tizen';\n")
        (self.repo / 'app/index.html').write_text('tagged app')
        (self.repo / 'README.md').write_text('https://github.com/YOUR-GITHUB-USER/f1tv-tizen\n')
        (self.repo / '.gitignore').write_text('build/\nlocal/\n')
        # Exercise the real assembler and deploy script; replace only the external SDK packager.
        self.sdk = self.repo / 'test-sdk'
        packager = self.sdk / 'tools/ide/bin/tizen'
        packager.parent.mkdir(parents=True)
        packager.write_text('''#!/usr/bin/env python3
from pathlib import Path
import sys, zipfile
assert sys.argv[1] == 'package'
Path('packager-called').touch()
source = Path(sys.argv[sys.argv.index('--') + 1])
out = Path(sys.argv[sys.argv.index('-o') + 1]) / 'sdk-output.wgt'
with zipfile.ZipFile(out, 'w') as package:
    for path in sorted(source.rglob('*')):
        if path.is_file():
            package.write(path, path.relative_to(source))
''')
        packager.chmod(0o755)
        self.git('init', '-q')
        self.git('config', 'user.name', 'Release Test')
        self.git('config', 'user.email', 'release@example.invalid')
        self.git('remote', 'add', 'origin', 'https://github.com/example/f1tv-tizen.git')
        self.git('add', '.')
        self.git('commit', '-qm', 'Initial')

    def run_command(self, *args):
        return subprocess.run(args, cwd=self.repo, text=True, capture_output=True,
                              env={**os.environ, 'TIZEN_HOME': str(self.sdk),
                                   'GIT_CONFIG_GLOBAL': '/dev/null', 'BUNDLE_SIGNING_KEY': self.bundle_key})

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
            self.assertEqual(archive.read('builtin/index.html'), b'tagged app')
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

    def publish_assets(self):
        self.tag()
        result = self.script('build-release.sh', 'v0.1.0')
        self.assertEqual(result.returncode, 0, result.stderr)
        result = self.run_command('node', 'scripts/sign-bundle.js', 'build/bundle.json')
        self.assertEqual(result.returncode, 0, result.stderr)

    def publish(self, state, missing=None):
        self.publish_assets()
        if missing:
            (self.repo / 'build' / missing).unlink()
        return self.github_script('publish-release.sh', state)

    def test_publish_rejects_bad_signature_before_any_github_call(self):
        self.publish_assets()
        (self.repo / 'build/bundle.json.sig').write_text('A' * 88)
        result = self.github_script('publish-release.sh', 'missing')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.repo / 'gh-calls.jsonl').exists())

    def test_publish_rejects_signed_wrong_version_before_any_github_call(self):
        self.publish_assets()
        manifest = self.repo / 'build/bundle.json'
        data = json.loads(manifest.read_text())
        data['version'] = '0.2.0'
        data['archive']['name'] = 'bundle-0.2.0.tar'
        shutil.copy2(self.repo / 'build/bundle-0.1.0.tar', self.repo / 'build/bundle-0.2.0.tar')
        manifest.write_text(json.dumps(data))
        signed = self.run_command('node', 'scripts/sign-bundle.js', 'build/bundle.json')
        self.assertEqual(signed.returncode, 0, signed.stderr)
        result = self.github_script('publish-release.sh', 'missing')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('version does not match', result.stderr)
        self.assertFalse((self.repo / 'gh-calls.jsonl').exists())

    def test_publish_rejects_either_bad_package_checksum_before_any_github_call(self):
        self.publish_assets()
        for name in ['F1TV.wgt']:
            package = self.repo / 'build' / name
            original = package.read_bytes()
            package.write_bytes(original + b'corrupt')
            result = self.github_script('publish-release.sh', 'missing')
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse((self.repo / 'gh-calls.jsonl').exists())
            package.write_bytes(original)

    def test_build_rejects_a_moved_tag_and_accepts_the_pinned_commit(self):
        self.tag()
        commit = self.git('rev-parse', 'HEAD')
        def pinned():
            return self.run_command('env', 'RELEASE_COMMIT=' + commit, 'bash', 'scripts/build-release.sh', 'v0.1.0', '--check')
        self.assertEqual(pinned().returncode, 0)
        self.git('commit', '--allow-empty', '-qm', 'Another commit')
        self.git('tag', '-f', 'v0.1.0')
        result = pinned()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('tested commit', result.stderr)

    def test_release_revocations_come_from_the_committed_cumulative_file(self):
        revokes = ['0.0.1', '0.0.2']
        (self.repo / 'scripts/revokes.json').write_text(json.dumps(revokes))
        self.git('add', 'scripts/revokes.json')
        self.git('commit', '-qm', 'Revoke broken versions')
        self.tag()
        (self.repo / 'scripts/revokes.json').write_text('[]')
        result = self.run_command('env', 'BUNDLE_REVOKES=9.0.0', 'bash', 'scripts/build-release.sh', 'v0.1.0')
        self.assertEqual(result.returncode, 0, result.stderr)
        manifest = json.loads((self.repo / 'build/bundle.json').read_text())
        self.assertEqual(manifest['revokes'], revokes)

    def github_script(self, script, state, tag='v0.1.0'):
        tools = self.repo / 'test-bin'
        tools.mkdir(exist_ok=True)
        # Record all operations. Only lookup returns data; no network or credentials.
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
        return subprocess.run(['bash', 'scripts/' + script, tag], cwd=self.repo,
                              text=True, capture_output=True,
                              env={**os.environ, 'PATH': str(tools) + os.pathsep + os.environ['PATH'],
                                   'GH_REPO': 'example/f1tv-tizen', 'RELEASE_STATE': state})

    def gh_calls(self):
        import json
        return [json.loads(line) for line in (self.repo / 'gh-calls.jsonl').read_text().splitlines()]

    def test_new_release_uploads_all_assets_as_draft_then_publishes_prerelease(self):
        result = self.publish('missing')
        self.assertEqual(result.returncode, 0, result.stderr)
        create = self.gh_calls()[-2]
        self.assertEqual(create[:3], ['release', 'create', 'v0.1.0'])
        self.assertIn('--draft', create)
        self.assertIn('--verify-tag', create)
        self.assertIn('build/F1TV.wgt', create)
        self.assertIn('build/F1TV.wgt.sha256', create)
        for asset in ['bundle-0.1.0.tar', 'bundle.json', 'bundle.json.sig']:
            self.assertIn('build/' + asset, create)
        self.assertFalse(any('staging' in a for a in create), 'one package only: test versions are a setting on the TV')

        self.assert_publish_transition()

    def assert_publish_transition(self):
        self.assertEqual(self.gh_calls()[-1], ['release', 'edit', 'v0.1.0', '--repo',
                                             'example/f1tv-tizen', '--draft=false', '--prerelease'])

    def test_retry_updates_only_draft_assets(self):
        result = self.publish('true')
        self.assertEqual(result.returncode, 0, result.stderr)
        upload = self.gh_calls()[-2]
        self.assertEqual(upload[:3], ['release', 'upload', 'v0.1.0'])
        self.assertIn('--clobber', upload)
        self.assert_publish_transition()

    def test_retry_refuses_published_release(self):
        result = self.publish('false')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('published', result.stderr)
        self.assertEqual(len(self.gh_calls()), 1)


    def test_release_build_makes_one_stable_package_with_its_checksum(self):
        self.tag()
        result = self.script('build-release.sh', 'v0.1.0')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse((self.repo / 'build/F1TV-staging.wgt').exists(), 'test versions are a setting on the TV, not a package')
        with zipfile.ZipFile(self.repo / 'build/F1TV.wgt') as stable:
            self.assertIn(b"channel: 'stable'", stable.read('launcher-build.js'))
        package = self.repo / 'build/F1TV.wgt'
        self.assertEqual((self.repo / 'build/F1TV.wgt.sha256').read_text().split(),
                         [hashlib.sha256(package.read_bytes()).hexdigest(), 'F1TV.wgt'])
        self.assertFalse((self.repo / 'build/bundle.json.sig').exists(), 'build must not sign, even with a secret in the environment')
        signed = self.run_command('node', 'scripts/sign-bundle.js', 'build/bundle.json')
        self.assertEqual(signed.returncode, 0, signed.stderr)
        verified = self.run_command('node', 'scripts/verify-bundle.js', 'build/bundle.json')
        self.assertEqual(verified.returncode, 0, verified.stderr)

    def test_deploy_update_modes_and_local_source_precedence(self):
        for mode, enabled, channel in [(None, False, 'stable'), ('off', False, 'stable'),
                                       ('stable', True, 'stable'), ('prerelease', True, 'prerelease')]:
            with self.subTest(mode=mode):
                env = {**os.environ, 'TIZEN_HOME': str(self.sdk)}
                env.pop('UPDATES', None)
                if mode is not None:
                    env['UPDATES'] = mode
                result = subprocess.run(['bash', 'scripts/deploy.sh', 'build'], cwd=self.repo,
                                        env=env, text=True, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                with zipfile.ZipFile(self.repo / 'build/F1TV.wgt') as package:
                    build = package.read('launcher-build.js').decode()
                    self.assertIn('updates: ' + str(enabled).lower(), build)
                    self.assertIn("channel: '" + channel + "'", build)
        override = "var LauncherBuild = {updates:true, source:'http://test.invalid', keys:{test:'public'}};"
        (self.repo / 'local/app').mkdir(parents=True)
        (self.repo / 'local/app/launcher-build.js').write_text(override)
        result = subprocess.run(['bash', 'scripts/deploy.sh', 'build'], cwd=self.repo,
                                env={**os.environ, 'TIZEN_HOME': str(self.sdk), 'UPDATES': 'stable'}, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        with zipfile.ZipFile(self.repo / 'build/F1TV.wgt') as package:
            self.assertEqual(package.read('launcher-build.js').decode(), override)
            self.assertNotIn('builtin/launcher-build.js', package.namelist())
        result = subprocess.run(['bash', 'scripts/deploy.sh', 'build'], cwd=self.repo,
                                env={**os.environ, 'TIZEN_HOME': str(self.sdk), 'UPDATES': 'beta'}, text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('UPDATES must be', result.stderr)

    def test_publish_refuses_missing_asset(self):
        result = self.publish('true', missing='bundle.json.sig')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('missing release asset', result.stderr)
        self.assertFalse((self.repo / 'gh-calls.jsonl').exists())

    def test_promote_reuses_complete_published_prerelease(self):
        assets = ['F1TV.wgt', 'F1TV.wgt.sha256', 'bundle-0.1.0.tar', 'bundle.json', 'bundle.json.sig']
        state = json.dumps(dict(isDraft=False, isPrerelease=True, assets=[dict(name=a) for a in assets]))
        result = self.github_script('promote-release.sh', state)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.gh_calls()[-1], ['release', 'edit', 'v0.1.0', '--repo',
                                             'example/f1tv-tizen', '--prerelease=false', '--latest'])
        self.assertEqual(len(self.gh_calls()), 2)

    def test_promote_refuses_missing_draft_full_and_incomplete_releases(self):
        assets = ['F1TV.wgt', 'F1TV.wgt.sha256', 'bundle-0.1.0.tar', 'bundle.json', 'bundle.json.sig']
        states = ['missing', json.dumps(dict(isDraft=True, isPrerelease=True)),
                  json.dumps(dict(isDraft=False, isPrerelease=False))]
        states += [json.dumps(dict(isDraft=False, isPrerelease=True, assets=[dict(name=a) for a in assets if a != missing]))
                   for missing in assets]
        for state in states:
            with self.subTest(state=state):
                result = self.github_script('promote-release.sh', state)
                self.assertNotEqual(result.returncode, 0)
                self.assertTrue(all(call[:2] == ['release', 'view'] for call in self.gh_calls()))

    def test_publish_and_promote_refuse_invalid_tags(self):
        for script in ['publish-release.sh', 'promote-release.sh']:
            for tag in ['v1.0.0-beta', 'main', 'v1.0.0;exit 0']:
                result = self.github_script(script, 'missing', tag)
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((self.repo / 'gh-calls.jsonl').exists())


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='f1tv-installer-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.payload = b'package-bytes'
        # Run the real option parser and download path, without TV discovery/installation.
        # The split relies on install.sh keeping its bare 'main' marker line (see the comment there).
        self.script = self.root / 'install.sh'
        self.script.write_text((ROOT / 'scripts/install.sh').read_text().rsplit('\nmain\n', 1)[0] + '\nget_wgt\n')
        curl = self.root / 'curl'
        curl.write_text('''#!/usr/bin/env python3
import hashlib, os, sys
from pathlib import Path
args = sys.argv[1:]
url = args[-1]
with open(os.environ['CURL_LOG'], 'a') as log:
    log.write(url + '\\n')
if 'api.github.com' in url:
    print(os.environ['RELEASE_JSON'])
elif url.endswith('.sha256'):
    print(('0' * 64 if os.environ.get('BAD_CHECKSUM') else hashlib.sha256(b'package-bytes').hexdigest()) + '  asset.wgt')
else:
    Path(args[args.index('-o') + 1]).write_bytes(b'package-bytes')
''')
        curl.chmod(0o755)

    def release(self, version, asset='F1TV.wgt', draft=False, prerelease=True):
        return dict(tag_name='v' + version, draft=draft, prerelease=prerelease,
                    body='Notes with {braces} and "quotes" and \\slashes', assets=[
                        dict(name=name, browser_download_url='https://example.invalid/v' + version + '/' + name)
                        for name in [asset, asset + '.sha256']])

    def install(self, release, staging=False, compact=False, bad_checksum=False):
        return subprocess.run(['bash', str(self.script)] + (['--staging'] if staging else []),
                              text=True, capture_output=True, env={**os.environ,
                                  'PATH': str(self.root) + os.pathsep + os.environ['PATH'],
                                  'XDG_CACHE_HOME': str(self.root / 'cache'),
                                  'CURL_LOG': str(self.root / 'curl.log'),
                                  'RELEASE_JSON': json.dumps(release, indent=None if compact else 2),
                                  'BAD_CHECKSUM': '1' if bad_checksum else ''})

    def test_staging_selects_first_non_draft_with_asset_in_pretty_and_compact_json(self):
        releases = [self.release('4.0.0', draft=True), self.release('3.0.0', asset='Other.wgt'),
                    self.release('2.0.0'), self.release('1.0.0', prerelease=False)]
        for compact in [False, True]:
            result = self.install(releases, staging=True, compact=compact)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((self.root / 'cache/f1tv-tizen/F1TV-2.0.0.wgt').read_bytes(), self.payload)
        urls = (self.root / 'curl.log').read_text()
        self.assertIn('/releases?per_page=20', urls)
        self.assertNotIn('/releases/latest', urls)
        self.assertNotIn('/v4.0.0/', urls)
        self.assertIn('/v2.0.0/F1TV.wgt.sha256', urls)

    def test_default_still_uses_latest_stable_and_separate_cache_name(self):
        result = self.install(self.release('1.0.0', asset='F1TV.wgt', prerelease=False))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / 'cache/f1tv-tizen/F1TV-1.0.0.wgt').read_bytes(), self.payload)
        self.assertIn('/releases/latest', (self.root / 'curl.log').read_text())

    def test_staging_accepts_full_release_and_rejects_bad_checksum(self):
        result = self.install([self.release('1.0.0', prerelease=False)], staging=True, bad_checksum=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("doesn't match its checksum", result.stderr)
        self.assertFalse(list((self.root / 'cache').rglob('*.wgt')))
        result = self.install([self.release('1.0.0', prerelease=False)], staging=True)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_staging_refuses_missing_asset_and_missing_checksum(self):
        for releases in [[], [self.release('1.0.0', asset='Other.wgt')]]:
            result = self.install(releases, staging=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('No published release', result.stderr)
        release = self.release('1.0.0')
        release['assets'].pop()
        result = self.install([release], staging=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('has no F1TV.wgt', result.stderr)

    def test_powershell_uses_staging_switch_selection_checksum_and_separate_cache(self):
        script = (ROOT / 'scripts/install.ps1').read_text()
        for text in ['[switch]$Staging', "'releases?per_page=20'", "'releases/latest'",
                     "$assetName = 'F1TV.wgt'", 'Write-StagingHint', 'type 1 2 3 4 5', '-not $_.draft', 'Select-Object -First 1',
                     '$_.name -eq "$assetName.sha256"', 'Get-Sha256 $part',
                     "$($assetName -replace '\\.wgt$', '')-$($script:Version).wgt"]:
            self.assertIn(text, script)


    def test_staging_marker_stays_a_label_and_the_installer_explains_test_versions(self):
        # install_app with a fake sdb: what the installer leaves on the TV for the app (f1tv-installed.json).
        pushed = self.root / 'pushed'
        pushed.mkdir()
        sdb = self.root / 'sdb'
        sdb.write_text("""#!/usr/bin/env bash
shift 2
case "$1" in
  capability) echo 'sdk_toolpath:/tv/sdk_tools' ;;
  push) cp "$2" "$PUSHED/$(basename "$3")" ;;
  shell) echo 'install completed' ;;
esac
""")
        sdb.chmod(0o755)
        wgt = self.root / 'F1TV.wgt'
        wgt.write_bytes(self.payload)
        # A label only (any app can write that shared file): --staging adds nothing to it, and says how to keep test versions.
        for staging, want in [(1, {'installedBy': 'installer', 'version': '1.3.0'}),
                              (0, {'installedBy': 'installer', 'version': '1.3.0'})]:
            script = self.root / ('install-%d.sh' % staging)
            script.write_text((ROOT / 'scripts/install.sh').read_text().rsplit('\nmain\n', 1)[0] +
                              '\nSDB="%s"; SERIAL=tv; WGT="%s"; VERSION=1.3.0; STAGING=%d\ninstall_app\n' % (sdb, wgt, staging))
            result = subprocess.run(['bash', str(script)], text=True, capture_output=True,
                                    env={**os.environ, 'PUSHED': str(pushed)})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads((pushed / 'f1tv-installed.json').read_text()), want)
            self.assertEqual('type 1 2 3 4 5' in result.stdout + result.stderr, bool(staging))


class WorkflowTests(unittest.TestCase):
    def test_release_job_dependencies_and_privilege_boundaries(self):
        text = (ROOT / '.github/workflows/release.yml').read_text()
        jobs = dict(re.findall(r'^  (test|build|sign|publish):\n(.*?)(?=^  \w+:|\Z)', text, re.M | re.S))
        self.assertEqual(set(jobs), {'test', 'build', 'sign', 'publish'})
        for job, dependency in [('build', 'test'), ('sign', '[test, build]'), ('publish', '[test, sign]')]:
            self.assertIn('needs: ' + dependency + '\n', jobs[job])
        self.assertIn('commit: ${{ steps.commit.outputs.sha }}', jobs['test'])
        self.assertIn('id: commit', jobs['test'])
        self.assertIn('git rev-parse HEAD', jobs['test'])
        self.assertEqual(text.count('ref: refs/tags/${{ env.RELEASE_TAG }}'), 1)
        for name in ['build', 'sign', 'publish']:
            self.assertIn('ref: ${{ needs.test.outputs.commit }}', jobs[name])
            self.assertIn('git rev-parse "refs/tags/$RELEASE_TAG^{commit}"', jobs[name])
            self.assertIn('= "$RELEASE_COMMIT"', jobs[name])
        self.assertIn('environment: bundle-signing', jobs['sign'])
        self.assertIn('actions/setup-node@v6', jobs['publish'])
        self.assertIn('permissions:\n  contents: read', text)
        self.assertEqual(text.count('contents: write'), 1)
        self.assertIn('contents: write', jobs['publish'])
        self.assertEqual(text.count('${{ secrets.BUNDLE_SIGNING_KEY }}'), 1)
        self.assertIn('${{ secrets.BUNDLE_SIGNING_KEY }}', jobs['sign'])
        for job in ['test', 'build', 'publish']:
            self.assertNotIn('BUNDLE_SIGNING_KEY', jobs[job])
        for job in ['build', 'sign']:
            self.assertIn('actions/upload-artifact@v7', jobs[job])
            self.assertIn('retention-days: 7', jobs[job])
        for job in ['sign', 'publish']:
            self.assertIn('actions/download-artifact@v8', jobs[job])
        self.assertIn('scripts/verify-bundle.js build/bundle.json', jobs['sign'])
        self.assertIn('scripts/publish-release.sh', jobs['publish'])
        for job in jobs.values():
            self.assertIn('actions/checkout@v6', job)
        self.assertIn('shell/*.js shell/vendor/*.js scripts/*.js', jobs['test'])
        self.assertIn('shell/*.js shell/vendor/*.js scripts/*.js', (ROOT / '.github/workflows/test.yml').read_text())

    def test_promotion_workflow_has_only_tag_input_and_no_build_or_sign(self):
        text = (ROOT / '.github/workflows/promote.yml').read_text()
        self.assertIn('workflow_dispatch:', text)
        self.assertIn('      tag:', text)
        self.assertNotIn('revoke:', text)
        self.assertIn('scripts/promote-release.sh "$RELEASE_TAG"', text)
        self.assertNotIn('BUNDLE_SIGNING_KEY', text)
        self.assertNotIn('build-release.sh', text)


if __name__ == '__main__':
    unittest.main()
