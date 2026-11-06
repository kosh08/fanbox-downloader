import json
from pathlib import Path
import tempfile
import unittest
import zipfile

from watch_unzip import run_once


class WindowsQueueTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.queue = self.root / '.fanbox-state' / 'windows-unzip'
        self.queue.mkdir(parents=True)

    def tearDown(self):
        self.temp.cleanup()

    def job(self, key='a' * 64, archive=None):
        archive = archive or self.root / 'creator' / 'app.zip'
        archive.parent.mkdir(exist_ok=True)
        with zipfile.ZipFile(archive, 'w') as z:
            z.writestr('日本語Unity/Runtime/plugin.dll', 'test data; not an executable')
            z.writestr('日本語Unity/data.json', '{}')
        info = archive.stat()
        job = {'version': 1, 'id': key, 'archive': list(archive.relative_to(self.root).parts),
               'size': info.st_size, 'modified': int(info.st_mtime * 1000)}
        path = self.queue / (key + '.json')
        path.write_text(json.dumps(job), encoding='utf-8')
        return archive, path, job

    def test_processes_once_preserves_names_and_writes_separate_result(self):
        archive, path, job = self.job()
        original = path.read_bytes()
        result = run_once(self.root)
        self.assertEqual(result[0]['status'], 'done')
        self.assertEqual(path.read_bytes(), original)
        self.assertTrue(archive.exists())
        self.assertTrue((archive.parent / 'app_展開/日本語Unity/Runtime/plugin.dll').exists())
        self.assertEqual(run_once(self.root), [])

    def test_existing_destination_is_reported_without_overwrite(self):
        archive, _, _ = self.job()
        destination = archive.parent / 'app_展開'
        destination.mkdir()
        (destination / 'keep.txt').write_text('keep')
        result = run_once(self.root)[0]
        self.assertEqual(result['status'], 'done')
        self.assertNotEqual(result['destination'], str(destination))
        self.assertTrue(Path(result['destination']).exists())
        self.assertEqual((destination / 'keep.txt').read_text(), 'keep')

    def test_changed_zip_is_refused_and_can_be_retried_explicitly(self):
        archive, path, job = self.job()
        job['size'] += 1
        path.write_text(json.dumps(job), encoding='utf-8')
        self.assertEqual(run_once(self.root)[0]['status'], 'error')
        self.assertEqual(run_once(self.root), [])
        job['size'] = archive.stat().st_size
        path.write_text(json.dumps(job), encoding='utf-8')
        self.assertEqual(run_once(self.root, retry_errors=True)[0]['status'], 'done')

    def test_malicious_paths_are_rejected_before_writing(self):
        archive, path, job = self.job()
        for parts in [['..', 'outside.zip'], ['C:', 'outside.zip'], ['creator/app.zip']]:
            job['archive'] = parts
            path.write_text(json.dumps(job), encoding='utf-8')
            self.assertEqual(run_once(self.root, retry_errors=True)[0]['status'], 'error')
        self.assertFalse((archive.parent / 'app_展開').exists())


if __name__ == '__main__':
    unittest.main()
