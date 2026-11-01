# Release instructions

- This repository uses a free, user-initiated updater for unpacked Chrome extensions. Do not re-enable Chrome Web Store publication or change repository visibility without the user asking.
- Canonical source is extension/. Build with python scripts/build.py after edits. Commit the generated extension/update.json together with the files it describes.
- Increment the manifest version for a release, and update the visible version in app.html. Update version-sensitive release tests if needed.
- Run node --test extension/tests/*.test.mjs and python -m unittest discover -s scripts -p 'test_*.py' -v.
- The updater checks an exact asset allowlist. New runtime files require updates to scripts/build.py FILES and extension/update.mjs PATHS. Do not include update.json in its own hash index.
- Never store GitHub tokens or FANBOX session information in source, logs, release ZIPs, or chat. Preserve private repository visibility.
- Repository updates are not proof of successful FANBOX downloads. State live-account verification limits.
