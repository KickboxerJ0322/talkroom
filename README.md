# Talkroom

Talkroom は、Node.js + Express + Socket.IO + WebRTC で作った 1対1の音声通話アプリです。  
現在は Google Cloud Speech-to-Text を使ったリアルタイム会話ログにも対応しています。

## 主な機能

- ルームID + PIN で 2人だけが参加できる音声通話
- WebRTC による双方向音声通信
- Google Cloud Speech-to-Text を使った会話ログ表示
- 自分と相手を分けた LINE 風のログ表示
- Cloud Run 向けのデプロイ構成

## ディレクトリ構成

- `server.js`
  - Express / Socket.IO サーバー
  - Google Cloud Speech-to-Text 連携
- `config/webrtc.js`
  - STUN / TURN 設定
- `public/index.html`
  - UI 本体
- `public/style.css`
  - 全体のスタイル
- `public/js/app.js`
  - 通話、ルーム参加、文字起こし制御
- `public/js/transcriptionStreamer.js`
  - マイク音声を WAV にしてサーバーへ送る処理
- `public/js/webrtcClient.js`
  - WebRTC 接続処理
- `public/js/ui.js`
  - UI 更新処理
- `.github/workflows/deploy-cloud-run.yml`
  - GitHub Actions から Cloud Run へ自動デプロイ

## ローカル起動

### 1. 依存関係

```bash
npm install
```

### 2. 環境変数

Google Cloud Speech-to-Text を使うため、ローカルでは `GOOGLE_CLOUD_API_KEY` を設定してください。

PowerShell:

```powershell
$env:GOOGLE_CLOUD_API_KEY="YOUR_API_KEY"
```

### 3. HTTP 起動

```bash
npm start
```

ブラウザ:

```text
http://localhost:3000
```

### 4. HTTPS 起動

スマホ実機テストでは HTTPS が便利です。まず開発用証明書を作成します。

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\generate-dev-cert.ps1
```

その後に起動します。

```bash
npm run start:https
```

ブラウザ:

```text
https://localhost:3443
```

## Google Cloud Speech-to-Text の設定

この実装はサーバー側から Google Cloud Speech-to-Text REST API を呼び出します。  
利用前に次を確認してください。

- 対象の Google Cloud プロジェクトで Speech-to-Text API を有効化する
- 使用する API キーに Speech-to-Text API の利用権限がある
- Cloud Run にも `GOOGLE_CLOUD_API_KEY` を設定する

例:

```bash
gcloud run services update talkroom \
  --region=asia-northeast1 \
  --update-env-vars=GOOGLE_CLOUD_API_KEY=YOUR_API_KEY
```

## Cloud Run デプロイ

このリポジトリは GitHub Actions から Cloud Run へ自動デプロイする前提です。  
`main` に push すると、設定済みのワークフローでデプロイされます。

現在のサービス情報:

- Project ID: `jumpeicloud`
- Region: `asia-northeast1`
- Service: `talkroom`

## 補足

- 文字起こしはブラウザ内の Web Speech API ではなく、各端末のマイク音声をサーバーへ送って処理します。
- そのため、スマホブラウザでも PC と同じ経路で文字起こししやすくなっています。
- 文字起こし結果は数秒単位で反映されるため、完全な逐語リアルタイムではなく、短い遅延があります。
