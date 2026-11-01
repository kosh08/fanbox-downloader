import json
from pathlib import Path
import shutil
import tempfile
import unittest
import zipfile

from build import ROOT, FILES, build, validate_manifest
from publish import PublishError, configuration, publish


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        shutil.copytree(ROOT / 'extension', self.root / 'extension')
        self.package = build(self.root, 'v1.0.1')
        self.config = {key: 'private-test-value' for key in ('CWS_CLIENT_ID', 'CWS_CLIENT_SECRET', 'CWS_REFRESH_TOKEN')}
        self.config.update(CWS_PUBLISHER_ID='publisher-1', CWS_EXTENSION_ID='a' * 32)

    def tearDown(self):
        self.temp.cleanup()

    def test_package_root_and_allowlist(self):
        (self.root / 'extension/credentials.json').write_text('private', encoding='utf-8')
        with zipfile.ZipFile(build(self.root)) as z:
            self.assertEqual(set(z.namelist()), set(FILES))
            self.assertEqual(json.loads(z.read('manifest.json'))['version'], '1.0.1')
            self.assertNotIn('credentials.json', z.namelist())

    def test_reproducible_build(self):
        before = self.package.read_bytes()
        self.assertEqual(build(self.root).read_bytes(), before)

    def test_tag_must_match_version(self):
        with self.assertRaises(ValueError):
            build(self.root, 'v9.0.0')

    def test_changed_permissions_require_review(self):
        m = json.loads((self.root / 'extension/manifest.json').read_text(encoding='utf-8'))
        m['permissions'].append('cookies')
        with self.assertRaises(ValueError):
            validate_manifest(m)

    def test_no_configuration_values_in_errors(self):
        with self.assertRaises(PublishError) as result:
            configuration({'CWS_CLIENT_SECRET': 'private-test-value'})
        self.assertNotIn('private-test-value', str(result.exception))
        self.assertIn('CWS_REFRESH_TOKEN', str(result.exception))

    def test_dry_run_never_requests_network(self):
        def reject(*args, **kwargs):
            self.fail('dry run attempted network')
        self.assertFalse(publish(self.package, {}, api=reject)['submitted'])

    def test_upload_async_poll_then_submit(self):
        calls = []
        responses = [{'access_token':'test-token'}, {'uploadState':'IN_PROGRESS'},
                     {'lastAsyncUploadState':'SUCCEEDED'}, {'state':'PENDING_REVIEW'}]
        def api(url, method='GET', data=None, headers=None):
            calls.append((url, method, data, headers))
            return responses.pop(0)
        result = publish(self.package, self.config, submit=True, api=api, wait=lambda _:None)
        self.assertTrue(result['submitted'])
        self.assertIn('/upload/v2/publishers/publisher-1/items/', calls[1][0])
        self.assertTrue(calls[2][0].endswith(':fetchStatus'))
        self.assertTrue(calls[3][0].endswith(':publish'))
        self.assertEqual(json.loads(calls[3][2]), {'publishType':'DEFAULT_PUBLISH','skipReview':False,'blockOnWarnings':True})

    def test_failed_upload_does_not_submit(self):
        calls = []
        def api(url, *args, **kwargs):
            calls.append(url)
            return {'access_token':'test-token'} if len(calls)==1 else {'uploadState':'FAILED'}
        with self.assertRaises(PublishError):
            publish(self.package, self.config, submit=True, api=api)
        self.assertEqual(len(calls), 2)

    def test_wrong_uploaded_version_does_not_submit(self):
        calls=[]
        def api(url, *args, **kwargs):
            calls.append(url)
            return {'access_token':'test-token'} if len(calls)==1 else {'uploadState':'SUCCEEDED','crxVersion':'99.0.0'}
        with self.assertRaises(PublishError):
            publish(self.package, self.config, submit=True, api=api)
        self.assertEqual(len(calls), 2)


if __name__ == '__main__':
    unittest.main()
