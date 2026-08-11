# Talkroom

Talkroom は、Node.js + Express + Socket.IO + WebRTC で構成した 1対1 の通話アプリです。  
音声通話に加えて、Google Cloud Speech-to-Text を使ったリアルタイム文字起こしと、カメラ映像の送信にも対応しています。

## 主な機能

- ルームID + PIN で 2 人だけが参加できる音声通話
- WebRTC による低遅延な音声通信
- Google Cloud Speech-to-Text を使ったリアルタイム文字起こし
- 文字起こしログの画面表示とテキスト書き出し
- カメラの ON / OFF による映像送信
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
  - スタイル定義
- `public/js/app.js`
  - 通話、ルーム参加、ボタン操作、カメラ切替などの制御
- `public/js/transcriptionStreamer.js`
  - マイク音声を WAV 相当の PCM にしてサーバーへ送信
- `public/js/webrtcClient.js`
  - WebRTC 接続処理
- `public/js/ui.js`
  - UI 更新処理
- `.github/workflows/deploy-cloud-run.yml`
  - GitHub Actions から Cloud Run へ自動デプロイ

## ローカル起動

### 1. 依存関係をインストール

```bash
npm install
```

### 2. 環境変数を設定

Google Cloud Speech-to-Text を使う場合は、ローカル環境で `GOOGLE_CLOUD_API_KEY` を設定してください。

PowerShell:

```powershell
$env:GOOGLE_CLOUD_API_KEY="YOUR_API_KEY"
```

### 3. HTTP で起動

```bash
npm start
```

ブラウザ:

```text
http://localhost:3000
```

### 4. HTTPS で起動

スマートフォン実機テストでは HTTPS が必要です。まず開発用証明書を生成します。

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

## 使い方

1. 同じ `ルームID` と `PIN` を 2 台で入力して入室します。
2. 通話開始後、`マイクOFF` / `スピーカーOFF` / `カメラON` ボタンで通話状態を切り替えます。
3. `カメラON` を押すと、その端末の前面カメラ映像が相手へ送信されます。
4. `カメラOFF` にすると映像送信を停止し、音声通話のみへ戻せます。
5. 文字起こしログは画面下部に表示され、必要に応じてテキスト保存できます。

## Google Cloud Speech-to-Text の設定

この実装では、サーバー側から Google Cloud Speech-to-Text REST API を呼び出します。  
利用前に次を確認してください。

- 対象の Google Cloud プロジェクトで Speech-to-Text API を有効化する
- 使用する API キーに Speech-to-Text API の利用権限がある
- Cloud Run には `GOOGLE_CLOUD_API_KEY` を設定する

例:

```bash
gcloud run services update talkroom \
  --region=asia-northeast1 \
  --update-env-vars=GOOGLE_CLOUD_API_KEY=YOUR_API_KEY
```

## Cloud Run デプロイ

このリポジトリは GitHub Actions から Cloud Run へ自動デプロイする前提です。  
`main` へ push すると、設定済みワークフローでデプロイされます。

現在のサービス情報:

- Project ID: `jumpeicloud`
- Region: `asia-northeast1`
- Service: `talkroom`

## 補足

- 文字起こしはブラウザ内の Web Speech API ではなく、端末マイク音声をサーバーへ送って処理しています。
- スマートフォンでは、マイクとカメラの利用許可をブラウザで許可してください。
- カメラ映像は `カメラON` を押した端末のみ送信されます。相手側も必要なら同様に有効化してください。
