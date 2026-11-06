"""Process the extension's local Windows ZIP queue; never launch archive contents."""
import argparse
from datetime import datetime
import json
import os
from pathlib import Path
import re
import sys
import time
import uuid

from windows_extract import extract_one, native


def process_job(root, path):
    job = json.loads(path.read_text(encoding='utf-8'))
    if job.get('version') != 1 or job.get('id') != path.stem:
        raise ValueError('展開リストの形式を確認できません。')
    parts = job.get('archive')
    if (not isinstance(parts, list) or not parts or
            any(not isinstance(p, str) or not p or p in ('.', '..') or
                re.search(r'[/\\:\x00]', p) for p in parts)):
        raise ValueError('ZIPの保存場所を確認できません。')
    archive = root.joinpath(*parts).resolve(strict=True)
    if not archive.is_relative_to(root):
        raise ValueError('作品保存先の外にあるファイルは処理しません。')
    info = archive.stat()
    if info.st_size != job.get('size') or abs(info.st_mtime * 1000 - job.get('modified', -1)) > 2:
        raise ValueError('元ZIPが更新されています。Chromeで保存し直した新しい展開リストを確認してください。')
    item = {'archive': str(archive), 'size': info.st_size, 'modifiedNs': str(info.st_mtime_ns)}
    destination = archive.with_name(archive.stem + '_展開')
    if destination.exists():
        stem = ''
        for char in archive.stem:
            if len((stem + char).encode('utf-16-le')) // 2 > 220:
                break
            stem += char
        destination = archive.with_name(stem + '_展開_' + path.stem[:12])
    result = extract_one(root, item, destination=destination)
    return {'status': 'done' if result['status'] == 'ok' else 'exists',
            'destination': result['destination'],
            'message': '元の名前・階層で展開しました。' if result['status'] == 'ok' else
                       '展開先がすでにあります。中身を確認してください（上書きはしていません）。'}


def run_once(root, retry_errors=False):
    root = Path(root).resolve(strict=True)
    queue = root / '.fanbox-state' / 'windows-unzip'
    if not queue.exists():
        return []
    if not queue.resolve().is_relative_to(root):
        raise ValueError('展開リストの場所が作品保存先の外です。')
    results = []
    for path in sorted(queue.iterdir()):
        if not re.fullmatch(r'[0-9a-f]{64}\.json', path.name):
            continue
        result_path = path.with_name(path.stem + '.result.json')
        if result_path.exists():
            try:
                old = json.loads(result_path.read_text(encoding='utf-8'))
                if not (retry_errors and old.get('status') == 'error'):
                    continue
            except (OSError, ValueError):
                if not retry_errors:
                    continue
        print('ZIPを確認・展開中…', flush=True)
        try:
            result = process_job(root, path)
        except Exception as error:
            result = {'status': 'error', 'message': str(error)}
        result.update({'jobId': path.stem, 'at': datetime.now().astimezone().isoformat()})
        temporary = queue / ('.result-' + uuid.uuid4().hex + '.tmp')
        temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        os.replace(native(temporary), native(result_path))
        results.append(result)
        print({'done': '展開完了', 'exists': '展開先あり・要確認', 'error': 'Windows側で要確認'}[result['status']] +
              '：' + result.get('destination', result['message']), flush=True)
    return results


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--once', action='store_true')
    parser.add_argument('--retry-errors', action='store_true')
    args = parser.parse_args()
    if args.retry_errors and not args.once:
        parser.error('再試行は --once と一緒に指定してください。')
    print(f'FANBOX Windows展開連携：{args.root}', flush=True)
    print('この画面を開いておくと、Chromeからの展開待ちZIPを順次処理します。終了は Ctrl+C。', flush=True)
    try:
        while True:
            results = run_once(args.root, args.retry_errors)
            if args.once:
                return int(any(r['status'] == 'error' for r in results))
            time.sleep(5)
    except KeyboardInterrupt:
        print('Windows展開連携を終了しました。', flush=True)
        return 0
    except Exception as error:
        print(f'処理を続けられません：{error}', flush=True)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
