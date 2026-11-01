"""Build a reproducible, allowlisted Chrome Web Store ZIP with manifest at root."""
import hashlib
import json
import os
from pathlib import Path
import re
import zipfile

ROOT = Path(__file__).resolve().parents[1]
FILES = ('manifest.json', 'app.html', 'app.mjs', 'background.js', 'core.mjs', 'style.css',
         'vendor/zip-native.min.js', 'vendor/zip.js-LICENSE.txt',
         'icons/16.png', 'icons/48.png', 'icons/128.png', 'update.mjs', 'update.json')


def validate_manifest(manifest):
    version = manifest.get('version', '')
    if not re.fullmatch(r'(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){0,3}', version) or any(int(v) > 65535 for v in version.split('.')) or not any(int(v) for v in version.split('.')):
        raise ValueError('Chrome manifest version is invalid')
    if manifest.get('manifest_version') != 3:
        raise ValueError('Manifest V3 is required')
    if set(manifest.get('permissions', [])) != {'storage', 'declarativeNetRequestWithHostAccess'}:
        raise ValueError('Review changed extension permissions before releasing')
    if set(manifest.get('host_permissions', [])) != {'https://*.fanbox.cc/*', 'https://*.pximg.net/*', 'https://fanbox.pixiv.net/*', 'https://api.github.com/*'}:
        raise ValueError('Review changed host permissions before releasing')
    if 'update_url' in manifest:
        raise ValueError('Chrome Web Store manages the update URL; do not set a GitHub update_url')
    return version


def build(root=ROOT, tag=None):
    source = Path(root) / 'extension'
    manifest = json.loads((source / 'manifest.json').read_text(encoding='utf-8'))
    version = validate_manifest(manifest)
    if tag and tag != 'v' + version:
        raise ValueError('Release tag must match manifest version: v' + version)
    index = {'application': 'fanbox-downloader', 'version': version, 'files': [
        {'path': name, 'size': (source / name).stat().st_size, 'sha256': hashlib.sha256((source / name).read_bytes()).hexdigest()}
        for name in FILES if name != 'update.json']}
    (source / 'update.json').write_bytes((json.dumps(index, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))
    dest = Path(root) / 'dist'
    dest.mkdir(exist_ok=True)
    archive = dest / ('FANBOX-Chrome-v' + version + '.zip')
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as z:
        for name in sorted(FILES):
            file = source / name
            if not file.is_file() or file.is_symlink():
                raise ValueError('Missing or invalid package asset: ' + name)
            info = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            z.writestr(info, file.read_bytes())
    with zipfile.ZipFile(archive) as z:
        if z.testzip() is not None or set(z.namelist()) != set(FILES):
            raise ValueError('Invalid package')
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    (dest / (archive.name + '.sha256')).write_text(digest + '  ' + archive.name + '\n', encoding='ascii')
    return archive


if __name__ == '__main__':
    print(build(tag=os.environ.get('RELEASE_TAG') or None))
