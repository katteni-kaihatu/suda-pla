# kokopla

ブラウザーで遊べる10m × 10mの軽量な3D空間です。Three.jsで空間を描画し、位置と視点はWebRTC DataChannelで参加者間に直接送ります。WebSocketはルーム参加と接続交渉にだけ使います。

公開URL: https://kokopla-alp.gspe.workers.dev/

## ローカルで起動

```powershell
npm ci
npm run build
npm run preview
```

`http://127.0.0.1:4173` を開きます。開発時は `npm run dev` を使えます。開発・Previewサーバーはローカル端末からのみアクセスできる設定です。

## Cloudflare Workersで固定URLを公開

Workers Static Assetsでゲーム画面を配信し、Durable ObjectsでルームとWebSocket接続を管理します。位置、視点、ファイルの共有は参加者間のWebRTC DataChannelで続けます。`workers.dev`のURLは同じWorker名で再デプロイしても維持され、公開後はこのPCを起動し続ける必要はありません。

```powershell
npm ci
npx wrangler login
npm run worker:deploy
```

デプロイが完了すると `https://kokopla-alp.<Cloudflareのサブドメイン>.workers.dev/` が表示されます。このURLでルームを作成し、招待リンクを共有します。独自ドメインを使う場合は、Cloudflareの **Workers & Pages → kokopla-alp → Domains → Add Domain** からCustom Domainを追加できます。Worker名やドメインの設定を変更しない限り、公開URLを維持できます。

ローカルでWorkers版を確認する場合は `npm run worker:dev` を実行し、`http://127.0.0.1:8787/` を開きます。`wrangler.jsonc` のSQLite-backed Durable Objectがルーム接続を担当します。ルームとデータアイテムはその場限りで、全員が退出するとルームは消えます。

TURNやIPFSを使う場合は、公開Workerに必要な値を設定します。秘密情報はソースや`wrangler.jsonc`に書かず、WranglerのSecretとして登録してください。

```powershell
npx wrangler secret put KOKOPLA_TURN_URLS
npx wrangler secret put KOKOPLA_TURN_SHARED_SECRET
npx wrangler secret put PINATA_JWT
```

`KOKOPLA_TURN_URLS`と`KOKOPLA_TURN_SHARED_SECRET`は両方設定した場合だけ有効です。`PINATA_JWT`がなければファイルはP2Pで共有します。ローカルのWorkers版に設定値を渡す場合は、Gitに含めない`.dev.vars`を作成します。詳細は下のTURNとIPFSの節を参照してください。

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
- 画像・ファイルを画面にドラッグ＆ドロップ：自分の目の位置から視線方向へ1mの位置に表示アイテムを配置。画像は縁なしで、縦横比に合わせて表示します。1ファイル5MB、合計20MB、最大16件まで。ルーム参加中はWebRTCで参加者にも共有します。
- データアイテムを右クリックしたまま：視線の1m先で掴んで移動。ボタンを離すとその場に置きます。ルーム参加中は位置もリアルタイムで共有します。

ルーム作成では推測しにくい8文字のコードを生成します。参加者は招待リンクまたは8文字コードを使います。ルームは最大8人です。

データアイテムはその場限りの表示で、サーバーには保存されません。ルーム退出またはページ再読み込みで消えます。物理コライダーを持たないため、プレイヤーはアイテムを通り抜けます。ルーム内の参加者にはドロップしたファイルの内容が共有されます。

## IPFSでファイルを共有する

PinataのJWTをサーバー環境変数`PINATA_JWT`に設定すると、ドロップしたファイルをブラウザーからPinataへ直接アップロードします。サーバーは60秒有効・最大5MBの署名付きURLだけを発行するため、JWTやファイル本体はアプリのP2Pシグナリングサーバーを通りません。参加者にはファイル本体ではなくCIDをWebRTCで送り、CIDからIPFSゲートウェイ経由で取得します。ゲートウェイは端末ごとに順番を分散し、失敗時は別ゲートウェイへ切り替えます。どちらからも取得できない場合はP2Pのファイル転送に切り替えます。

Pinataでファイル書き込み権限（`org:files:write`）を持つJWTを発行し、Previewを起動するPowerShellで設定します。JWTを`.env`やフロントエンドのソースへ書かないでください。

```powershell
$env:PINATA_JWT = 'PinataのJWT'
$env:KOKOPLA_IPFS_GATEWAYS = 'https://ipfs.io/ipfs/,https://dweb.link/ipfs/'
npm run build
npm run preview
```

`PINATA_JWT`を設定しない場合は従来どおりP2Pで共有します。IPFS設定時にアップロードしたファイルは公開ネットワーク上で取得可能になり、ページを閉じてもPinata側の保存は自動削除されません。機密ファイルはアップロードしないでください。署名URLの発行は接続元あたり毎分20回、アプリ全体で毎時120回までです。

## 運用上の制約

- ローカルPreviewのシグナリングサーバーはプロセス内メモリにルームを保持します。Previewを再起動すると全ルームが終了し、複数インスタンス間でルームは共有されません。Workers版ではDurable Objectが接続中のルームを管理します。
- 同時WebSocket接続数と部屋数には上限があり、無操作で参加しない接続は10秒で閉じます。
- TURN未設定時は、ネットワーク環境によってP2P接続できないことがあります。
- Cloudflare Tunnelは公開経路を提供しますが、アプリと端末自体を常時稼働させる必要があります。
