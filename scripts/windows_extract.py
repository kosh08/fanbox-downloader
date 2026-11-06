"""Extract only the prepared FANBOX ZIP list, preserving names; never run contents."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import time
import uuid
import zipfile

MAX_FILES = 100_000
MAX_BYTES = 20 * 1024 ** 3


def native(path):
    value = str(path)
    if os.name == 'nt' and not value.startswith('\\\\?\\'):
        return '\\\\?\\' + value
    return value


def open_archive(path):
    # UTF-8 entries override metadata_encoding. Legacy Japanese ZIPs use CP932.
    try:
        return zipfile.ZipFile(native(path), metadata_encoding='cp932')
    except UnicodeDecodeError:
        return zipfile.ZipFile(native(path))


def archive_plan(archive):
    entries = archive.infolist()
    if len(entries) > MAX_FILES:
        raise ValueError('ZIPの項目数が10万件を超えます。手動で確認してください。')
    total, seen, plan = 0, {}, []
    for entry in entries:
        raw = entry.filename.replace('\\', '/')
        parts = raw.rstrip('/').split('/')
        if (not raw or raw.startswith('/') or
                any(not p or p in ('.', '..') for p in parts) or
                stat.S_ISLNK(entry.external_attr >> 16)):
            raise ValueError('ZIP内に保存先の外へ出るパス、またはリンクがあります。')
        if entry.flag_bits & 1:
            raise ValueError('パスワード付きZIPです。手動で展開してください。')
        for part in parts:
            if (re.search(r'[<>:"|?*\x00-\x1f]', part) or
                    part.endswith((' ', '.')) or
                    re.match(r'^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)', part, re.I) or
                    len(part.encode('utf-16-le')) // 2 > 255):
                raise ValueError('Windowsで元の名前のまま保存できない項目があります。')
        key = '/'.join(parts).casefold()
        is_dir = entry.is_dir()
        if key in seen and not (seen[key] and is_dir):
            raise ValueError('ZIP内の名前がWindows上で重複します。上書きせず中止しました。')
        seen[key] = is_dir
        total += entry.file_size
        if total > MAX_BYTES or entry.file_size > max(entry.compress_size, 1) * 1000:
            raise ValueError('展開容量・圧縮率の確認が必要です（自動処理の上限超過）。')
        plan.append((entry, parts))
    # Also reject a regular file used as the parent of another entry.
    for _, parts in plan:
        for i in range(1, len(parts)):
            if seen.get('/'.join(parts[:i]).casefold()) is False:
                raise ValueError('ZIP内のファイル名とフォルダ名が衝突しています。')
    return plan, total


def candidate_path(root, item):
    archive = Path(item['archive']).resolve(strict=True)
    if not archive.is_relative_to(root) or archive.suffix.lower() != '.zip':
        raise ValueError('指定したFANBOX保存先以外のファイルは処理しません。')
    info = archive.stat()
    if info.st_size != item['size'] or info.st_mtime_ns != int(item['modifiedNs']):
        raise ValueError('準備後に元ZIPが変更されています。対象一覧を作り直してください。')
    return archive


def cleanup_stage(stage, parent, root):
    # Only this run's fresh staging directory can ever be removed.
    resolved = stage.resolve()
    if (stage.is_symlink() or resolved.parent != parent or
            not resolved.is_relative_to(root) or
            not re.fullmatch(r'\.fanbox-unzip-[0-9a-f]{32}', stage.name)):
        raise ValueError('一時フォルダの場所を確認できないため削除しません。')
    shutil.rmtree(native(resolved))


def extract_one(root, item, dry_run=False, destination=None):
    archive = candidate_path(root, item)
    destination = (Path(destination).resolve() if destination else
                   archive.with_name(archive.stem + '_展開'))
    if destination.parent != archive.parent or not destination.is_relative_to(root):
        raise ValueError('元ZIPの隣以外には展開しません。')
    if destination.exists():
        return {'status': 'skip', 'archive': str(archive), 'destination': str(destination),
                'message': '展開先がすでにあります。上書きしません。'}
    with open_archive(archive) as source:
        plan, total = archive_plan(source)
        if dry_run:
            return {'status': 'ready', 'archive': str(archive), 'destination': str(destination),
                    'files': sum(not e.is_dir() for e, _ in plan), 'expandedBytes': total}
        if shutil.disk_usage(native(archive.parent)).free < total + 16 * 1024 ** 2:
            raise OSError('展開先の空き容量が不足しています。')
        stage = archive.parent / ('.fanbox-unzip-' + uuid.uuid4().hex)
        os.mkdir(native(stage))
        current = ''
        try:
            for entry, parts in plan:
                current = '/'.join(parts)
                target = stage.joinpath(*parts)
                if not target.resolve().is_relative_to(stage.resolve()):
                    raise ValueError('ZIPの保存先を確認できません。')
                if entry.is_dir():
                    os.makedirs(native(target), exist_ok=True)
                    continue
                os.makedirs(native(target.parent), exist_ok=True)
                # Reading to EOF verifies the member's CRC before finalizing the folder.
                with source.open(entry) as reader, open(native(target), 'xb') as writer:
                    shutil.copyfileobj(reader, writer, length=1024 * 1024)
            if destination.exists():
                raise FileExistsError('展開先が別の処理で作成されました。上書きしません。')
            if (stage.resolve().parent != archive.parent or
                    destination.resolve().parent != archive.parent or
                    not stage.resolve().is_relative_to(root) or
                    not destination.resolve().is_relative_to(root)):
                raise ValueError('展開先の場所を確認できないため移動しません。')
            os.rename(native(stage), native(destination))
        except BaseException as error:
            try:
                cleanup_stage(stage, archive.parent, root)
            except OSError:
                pass
            if isinstance(error, (KeyboardInterrupt, SystemExit)):
                raise
            raise RuntimeError(f'{current or "ZIP読み取り"}：{error}') from error
    return {'status': 'ok', 'archive': str(archive), 'destination': str(destination),
            'files': sum(not e.is_dir() for e, _ in plan), 'expandedBytes': total}


def run(manifest, dry_run=False):
    root = Path(manifest['root']).resolve(strict=True)
    items = manifest['archives']
    results = []
    print(f'対象：{len(items)} ZIP ／ 保存先：{root}', flush=True)
    print('確認のみです。作品フォルダへの書き込みは行いません。' if dry_run else
          '元ZIPを残し、元のファイル名・階層で展開します。中身の起動は行いません。', flush=True)
    for index, item in enumerate(items, 1):
        print(f'[{index}/{len(items)}] {Path(item["archive"]).name}', flush=True)
        try:
            result = extract_one(root, item, dry_run)
        except KeyboardInterrupt:
            print('中断しました。完了済みフォルダは残し、次回は上書きせずスキップします。', flush=True)
            results.append({'status': 'interrupted', 'archive': item['archive']})
            break
        except Exception as error:
            result = {'status': 'error', 'archive': item.get('archive', ''), 'message': str(error)}
        results.append(result)
        labels = {'ok': '展開完了', 'ready': '展開可能', 'skip': 'スキップ', 'error': '失敗'}
        print('  ' + labels[result['status']] + ('：' + result['message'] if result.get('message') else ''), flush=True)
    return results


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    parser = argparse.ArgumentParser()
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--dry-run', action='store_true')
    options = parser.parse_args()
    try:
        manifest = json.loads(options.manifest.read_text(encoding='utf-8-sig'))
        results = run(manifest, options.dry_run)
    except Exception as error:
        print(f'処理を開始できませんでした：{error}', flush=True)
        return 1
    report = options.manifest.parent / ('対象確認結果.json' if options.dry_run else '展開結果.json')
    report.write_text(json.dumps({'at': time.strftime('%Y-%m-%d %H:%M:%S'), 'results': results},
                                 ensure_ascii=False, indent=2), encoding='utf-8')
    counts = {s: sum(r['status'] == s for r in results) for s in ('ok', 'ready', 'skip', 'error', 'interrupted')}
    summary = f'終了：展開 {counts["ok"]} ／ 確認 {counts["ready"]} ／ スキップ {counts["skip"]} ／ 失敗 {counts["error"]}'
    lines = [summary, '']
    for result in results:
        lines.append(result['status'] + '：' + result['archive'])
        if result.get('destination'):
            lines.append('  展開先：' + result['destination'])
        if result.get('message'):
            lines.append('  ' + result['message'])
    text_report = report.with_suffix('.txt')
    text_report.write_text('\n'.join(lines) + '\n', encoding='utf-8-sig')
    print(summary, flush=True)
    print(f'結果：{text_report}', flush=True)
    return int(bool(counts['error'] or counts['interrupted']))


if __name__ == '__main__':
    raise SystemExit(main())
