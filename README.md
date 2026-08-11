# Talkroom

Node.js + Express + Socket.IO + WebRTC で作った、1対1の音声通話アプリです。  
ローカル開発に加えて、Google Cloud Run へデプロイしてスマホから確認できる構成にしています。

## 構成

- `server.js`
  - Express で静的ファイルを配信
  - Socket.IO でシグナリングを処理
  - 開発用に HTTP / HTTPS を切り替え可能
- `config/webrtc.js`
  - STUN / TURN 設定を環境変数から組み立て
- `public/index.html`
  - UI 本体
- `public/style.css`
  - スマホ向けレスポンシブデザイン
- `public/js/app.js`
  - 全体の初期化とイベント接続
- `public/js/socketClient.js`
  - Socket.IO ラッパー
- `public/js/webrtcClient.js`
  - WebRTC 接続処理
- `public/js/ui.js`
  - UI 更新
- `public/js/state.js`
  - クライアント状態
- `scripts/smoke-signal-test.js`
  - Socket.IO シグナリングのスモークテスト
- `scripts/generate-dev-cert.ps1`
  - 開発用 HTTPS 証明書を生成
- `Dockerfile`
  - Cloud Run 用コンテナ定義
- `.github/workflows/deploy-cloud-run.yml`
  - GitHub から Cloud Run へ自動デプロイ

## ローカル起動

### HTTP で起動

```bash
npm install
npm start
```

```text
http://localhost:3000
```

### HTTPS で起動

まず開発用証明書を生成します。

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\generate-dev-cert.ps1
```

次に HTTPS サーバーを起動します。

```bash
npm run start:https
```

```text
https://localhost:3443
```

## 2 台でテストする方法

### もっとも簡単な方法

- 同じ PC で Chrome と Edge を開く
- どちらも `https://localhost:3443` を使う
- 同じルーム ID で参加する

### スマホを含めるおすすめ方法

Cloud Run にデプロイして、発行された HTTPS URL を PC とスマホで開きます。

## Cloud Run へデプロイする

Cloud Run では `PORT` 環境変数が自動で渡されるため、このアプリはそのまま動きます。  
一方で Socket.IO を安定させるため、まずは **単一インスタンス運用** を前提にしています。

### 1. Google Cloud プロジェクトを作成

Google Cloud Console でプロジェクトを用意します。

例:

- Project ID: `jumpeicloud`
- Region: `asia-northeast1`

### 2. 必要な API を有効化

Cloud Shell かローカルの `gcloud` で以下を実行します。

```bash
gcloud services enable run.googleapis.com artifactregistry.googleapis.com iam.googleapis.com cloudbuild.googleapis.com sts.googleapis.com
```

### 3. Artifact Registry を作成

```bash
gcloud artifacts repositories create talkroom \
  --repository-format=docker \
  --location=asia-northeast1
```

### 4. GitHub Actions 用のサービスアカウントを作成

```bash
gcloud iam service-accounts create github-deployer \
  --display-name="GitHub Cloud Run Deployer"
```

次に、このサービスアカウントへ権限を付けます。

```bash
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:github-deployer@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/run.admin"
```

```bash
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:github-deployer@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/artifactregistry.writer"
```

```bash
gcloud projects add-iam-policy-binding YOUR_PROJECT_ID \
  --member="serviceAccount:github-deployer@YOUR_PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountUser"
```

### 5. GitHub Actions と Google Cloud を Workload Identity Federation で接続

まず Workload Identity Pool を作成します。

```bash
gcloud iam workload-identity-pools create github-pool \
  --location=global \
  --display-name="GitHub Actions Pool"
```

次に Provider を作成します。

```bash
gcloud iam workload-identity-pools providers create-oidc github-provider \
  --location=global \
  --workload-identity-pool=github-pool \
  --display-name="GitHub Actions Provider" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository"
```

GitHub リポジトリ `KickboxerJ0322/actionrpg` からの利用を許可します。

```bash
gcloud iam service-accounts add-iam-policy-binding github-deployer@YOUR_PROJECT_ID.iam.gserviceaccount.com \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/YOUR_PROJECT_NUMBER/locations/global/workloadIdentityPools/github-pool/attribute.repository/KickboxerJ0322/actionrpg"
```

### 6. GitHub の Variables と Secrets を設定

GitHub リポジトリの `Settings > Secrets and variables > Actions` で以下を設定します。

Variables:

- `GCP_PROJECT_ID`: Google Cloud の Project ID
- 例 `jumpeicloud`
- `GCP_REGION`: 例 `asia-northeast1`
- `GAR_LOCATION`: 例 `asia-northeast1`
- `GAR_REPOSITORY`: 例 `talkroom`
- `CLOUD_RUN_SERVICE`: 例 `talkroom`

Secrets:

- `GCP_WORKLOAD_IDENTITY_PROVIDER`: `projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github-pool/providers/github-provider`
- `GCP_SERVICE_ACCOUNT`: `github-deployer@YOUR_PROJECT_ID.iam.gserviceaccount.com`

### 7. GitHub へ push する

`main` ブランチへ push すると、GitHub Actions が以下を自動で行います。

- Docker イメージをビルド
- Artifact Registry へ push
- Cloud Run へデプロイ

初回は Cloud Run サービスが自動作成されます。

### 8. 公開 URL を開く

デプロイ後、GitHub Actions のログか Google Cloud Console で Cloud Run の URL を確認します。  
その `https://...run.app` を PC とスマホで開き、同じルーム ID で参加します。

## TURN サーバー設定

STUN のみでも動くことはありますが、モバイル回線や厳しいネットワークでは音声がつながりにくくなります。  
本番寄りに使うなら TURN を設定してください。

Cloud Run サービスに環境変数を追加する例:

```bash
gcloud run services update talkroom \
  --region=asia-northeast1 \
  --update-env-vars=WEBRTC_TURN_URLS=turn:your-turn.example.com:3478,WEBRTC_TURN_USERNAME=your-user,WEBRTC_TURN_CREDENTIAL=your-password
```

STUN を独自設定したい場合:

```bash
gcloud run services update talkroom \
  --region=asia-northeast1 \
  --update-env-vars=WEBRTC_STUN_URLS=stun:stun.l.google.com:19302
```

## 独自ドメインを付けたい場合

Cloud Run の標準 URL ではなく独自ドメインを使いたい場合は、Cloud Run の `Custom Domains` を設定します。  
まずは `run.app` で動作確認し、そのあと独自ドメイン化するのがおすすめです。

## 注意点

- Cloud Run ではブラウザ接続が増えたときの Socket.IO スケール設計が別途必要です
- このリポジトリの GitHub Actions はまず `--max-instances=1` で安全側に寄せています
- 本番では TURN サーバー導入を強く推奨します
- ローカル HTTPS 証明書は Cloud Run では不要です
