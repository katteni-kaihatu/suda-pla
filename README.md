# kokopla

ブラウザーで遊べる10m × 10mの軽量な3D空間です。Three.jsで空間を描画し、位置と視点はWebRTC DataChannelで参加者間に直接送ります。WebSocketはルーム参加と接続交渉にだけ使います。

## ローカルで起動

```powershell
npm ci
npm run build
npm run preview
```

`http://127.0.0.1:4173` を開きます。開発時は `npm run dev` を使えます。開発・Previewサーバーはローカル端末からのみアクセスできる設定です。

## Cloudflare Tunnelで共有

Previewを起動したまま、別のPowerShellで次を実行します。

```powershell
cloudflared tunnel --url http://127.0.0.1:4173
```

表示された `https://...trycloudflare.com` を共有します。Quick TunnelのURLは一時的です。`cloudflared` が見つからない場合は、Cloudflareの公式手順に従って `cloudflared` をインストールしてください。

常に同じURLを使うには、Cloudflareアカウントに独自ドメインを登録し、ダッシュボードの **Networking → Tunnels** でTunnelを作成します。TunnelのPublic Hostnameを `plaza.example.com` などにし、Serviceを `http://127.0.0.1:4173` に設定します。Previewを起動するPowerShellでホスト名を許可してから起動してください。

```powershell
$env:KOKOPLA_ALLOWED_HOSTS = 'plaza.example.com'
npm run build
npm run preview
```

固定URLはアプリを動かすPCまたはサーバーが起動している間だけ利用できます。Tunnelとアプリを常時起動するには、`cloudflared` とPreviewをWindowsサービスやタスクスケジューラで起動する設定も必要です。環境変数を使う場合は、Previewを起動するサービス／タスク側にも同じ値を設定してください。

## TURNを設定する

STUNだけで接続できないNATやネットワークではTURNサーバーが必要です。coturnなど、TURN REST API形式の一時資格情報に対応したサーバーを用意し、TURNサーバーとアプリに同じ共有シークレットを設定します。共有シークレットはフロントエンドのビルドに含まれず、ブラウザーには有効期限10分の個別資格情報だけを返します。資格情報の発行は接続元ごとに1分20回までです。TURNサービス側にも利用者数・割当数・転送量の上限を設定してください。アプリの発行制限だけでは、発行済み資格情報の利用量は制限できません。

PowerShellの例です。URLとシークレットは実際のTURNサーバーの設定に合わせてください。

```powershell
$env:KOKOPLA_TURN_URLS = 'turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp'
$env:KOKOPLA_TURN_SHARED_SECRET = 'coturnのstatic-auth-secretと同じ値'
npm run build
npm run preview
```

coturn側ではTURN REST認証を有効にし、`static-auth-secret` に同じ値を設定します。直接接続を避けてTURN中継だけを使う場合は、TURNを設定したうえで次も指定します。

```powershell
$env:KOKOPLA_RELAY_ONLY = 'true'
```

TURNを設定しない場合はSTUN接続を試みますが、全てのネットワークで接続できるわけではありません。通常のP2P接続では参加者同士にネットワークアドレスが見える場合があります。ゲーム画面のマルチプレイ欄にも参加前にこの点を表示します。`KOKOPLA_RELAY_ONLY=true` はTURNサーバー経由に限定しますが、通信遅延とTURN側の通信量が増えます。

## 操作

- `W A S D`：移動
- 画面クリック：マウスで視点操作を開始（`Esc`で解除）
- 歩行中の`Space`：ジャンプ
- 飛行中の`Space`：上昇
- マウス中クリック：歩行・ノークリップ飛行を切り替え
- `F`：一人称・三人称視点を切り替え

ルーム作成では推測しにくい8文字のコードを生成します。参加者は招待リンクまたは8文字コードを使います。ルームは最大8人です。

## 運用上の制約

- シグナリングサーバーはプロセス内メモリにルームを保持します。Previewを再起動すると全ルームが終了し、複数インスタンス間でルームは共有されません。
- 同時WebSocket接続数と部屋数には上限があり、無操作で参加しない接続は10秒で閉じます。
- TURN未設定時は、ネットワーク環境によってP2P接続できないことがあります。
- Cloudflare Tunnelは公開経路を提供しますが、アプリと端末自体を常時稼働させる必要があります。
