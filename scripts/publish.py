"""Submit a built package using the official Chrome Web Store API v2.

Never print server responses: OAuth credentials must stay in GitHub Secrets.
"""
import argparse
import json
import os
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]


class PublishError(Exception):
    pass


def request(url, method='GET', data=None, headers=None):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=headers or {}, method=method), timeout=120) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        code = error.code
        error.close()
        raise PublishError(f'Chrome Web Store API returned HTTP {code}. Check credentials, version and dashboard status. Response values are omitted.') from None
    except (urllib.error.URLError, OSError, ValueError):
        raise PublishError('Chrome Web Store API communication failed. No credentials or response values were logged.') from None


def configuration(env):
    required = ('CWS_PUBLISHER_ID', 'CWS_EXTENSION_ID', 'CWS_CLIENT_ID', 'CWS_CLIENT_SECRET', 'CWS_REFRESH_TOKEN')
    missing = [key for key in required if not env.get(key)]
    if missing:
        raise PublishError('Missing GitHub configuration names: ' + ', '.join(missing))
    if not re.fullmatch(r'[a-zA-Z0-9_-]+', env['CWS_PUBLISHER_ID']) or not re.fullmatch(r'[a-p]{32}', env['CWS_EXTENSION_ID']):
        raise PublishError('Publisher ID or extension ID format is invalid')
    return {key: env[key] for key in required}


def publish(package, config, submit=False, api=request, wait=time.sleep):
    package = Path(package)
    with zipfile.ZipFile(package) as z:
        version = json.loads(z.read('manifest.json'))['version']
    if not submit:
        return {'version': version, 'submitted': False}
    body = urllib.parse.urlencode({'client_id': config['CWS_CLIENT_ID'], 'client_secret': config['CWS_CLIENT_SECRET'], 'refresh_token': config['CWS_REFRESH_TOKEN'], 'grant_type': 'refresh_token'}).encode()
    token = api('https://oauth2.googleapis.com/token', 'POST', body, {'Content-Type': 'application/x-www-form-urlencoded'}).get('access_token')
    if not token:
        raise PublishError('OAuth did not return an access token')
    auth = {'Authorization': 'Bearer ' + token}
    name = f"publishers/{config['CWS_PUBLISHER_ID']}/items/{config['CWS_EXTENSION_ID']}"
    upload = api('https://chromewebstore.googleapis.com/upload/v2/' + name + ':upload', 'POST', package.read_bytes(), {**auth, 'Content-Type': 'application/zip'})
    state = upload.get('uploadState')
    # Never retry upload/publish automatically: their completion can be ambiguous after a network failure.
    for _ in range(24):
        if state not in ('IN_PROGRESS', 'UPLOAD_IN_PROGRESS'):
            break
        wait(5)
        status = api('https://chromewebstore.googleapis.com/v2/' + name + ':fetchStatus', headers=auth)
        state = status.get('lastAsyncUploadState')
    if state != 'SUCCEEDED':
        raise PublishError('Upload is incomplete or unsuccessful. Check the developer dashboard before retrying.')
    if upload.get('crxVersion') and upload['crxVersion'] != version:
        raise PublishError('Uploaded version does not match local package')
    result = api('https://chromewebstore.googleapis.com/v2/' + name + ':publish', 'POST', json.dumps({'publishType': 'DEFAULT_PUBLISH', 'skipReview': False, 'blockOnWarnings': True}).encode(), {**auth, 'Content-Type': 'application/json'})
    if not result.get('state') or result['state'] == 'ITEM_STATE_UNSPECIFIED':
        raise PublishError('Submission status is unknown. Check the developer dashboard.')
    return {'version': version, 'submitted': True, 'state': result['state']}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--submit', action='store_true', help='Actually upload and submit for store review')
    parser.add_argument('--package', type=Path)
    args = parser.parse_args()
    try:
        version = json.loads((ROOT / 'extension/manifest.json').read_text(encoding='utf-8'))['version']
        package = args.package or ROOT / 'dist' / ('FANBOX-Chrome-v' + version + '.zip')
        config = configuration(os.environ) if args.submit else {}
        result = publish(package, config, submit=args.submit)
        print('Submitted for store review; user rollout depends on approval.' if result['submitted'] else 'Dry run only: no upload or submission performed.')
    except (PublishError, OSError, ValueError, zipfile.BadZipFile, KeyError) as e:
        print(str(e) if isinstance(e, PublishError) else 'Package or configuration could not be read.', file=sys.stderr)
        sys.exit(1)
