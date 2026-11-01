# FANBOX まとめて保存 — 自動配布用リポジトリ

FANBOX拡張機能のソース・テスト・配布の仕組みをまとめた一式です。

**現在は配布準備まで完了しています。GitHubリポジトリとChromeウェブストアへの登録・認証設定は未実施です。自動更新はまだ稼働していません。**

## 初期設定後の流れ

1. 修正版のソースをGitHubに入れ、拡張機能のバージョン番号を上げる。
2. GitHubの「Releases」から、同じ番号のタグ（例 `v1.0.2`）でリリースを公開する。
3. GitHub Actionsがテストと配布ZIPの作成を実行し、ZIPをリリースに添付する。
4. 設定が有効なら、Chromeウェブストアへ更新版をアップロードして審査申請する。
5. 審査通過後、**ストア版をインストールしたChrome**へChrome標準の仕組みで更新が配信される。

更新は即時ではなく、審査やChromeの更新確認による待ち時間があります。更新が不要なときはGitHubリリースを作らず、コードだけ変更できます。

## 最初に読むもの

- [初回設定の手順](docs/初回設定.md)
- [ストア掲載文と権限の説明](docs/ストア掲載文.md)
- [プライバシー説明](docs/プライバシー.md)
- [拡張機能の使い方](extension/使い方.md)

`extension/` が拡張機能です。`dist/` に作られるZIPは、Chromeウェブストアへのアップロード用で、ZIPの一番上に `manifest.json` が入ります。

## 動作確認

Node.js 24以上とPython 3.10以上で、追加パッケージなしで実行できます。

```text
node --test extension/tests/core.test.mjs
python -m unittest discover -s scripts -p "test_*.py" -v
python scripts/build.py
python scripts/publish.py
```

最後のコマンドは通信を行わない確認モードです。ストア申請は `--submit` を付け、必要な認証設定を用意した場合だけ実行します。

## 配布の制約

Windows版Chromeの通常利用では、GitHub ReleasesにZIPを置いただけでは拡張機能の自動更新は有効になりません。本構成はChromeウェブストアでの配信を使います。現在の「パッケージ化されていない拡張機能」は自動でストア版に変わらないため、**初回だけストア版へのインストール切り替えが必要**です。設定や保存先の許可も再設定が必要になる場合があります。

本拡張機能はFANBOX公式製品ではありません。実アカウントの支援投稿の取得、ストアでの審査・公開、GitHub Actionsのクラウド上の実行は未検証です。ローカルの自動テストとZIP検証を行っています。

## 公式資料

- [Chromeの配信方法の制約](https://developer.chrome.com/docs/extensions/how-to/distribute/host-on-linux)
- [ChromeウェブストアAPIの初期設定](https://developer.chrome.com/docs/webstore/using-api)
- [アップロードAPI](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/media/upload)
- [審査申請API](https://developer.chrome.com/docs/webstore/api/reference/rest/v2/publishers.items/publish)
