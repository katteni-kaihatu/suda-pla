# kokopla

ブラウザで動く10m × 10mの3D空間です。WebRTC DataChannelで位置・視点を端末間で直接同期し、Cloudflare Tunnel経由のWebSocketはルーム参加と接続交渉に使います。

## 起動と公開

1. `npm install`
2. `npm run build`
3. `npm run preview -- --host 0.0.0.0 --port 4173`
4. 別のターミナルで `cloudflared tunnel --url http://localhost:4173`
5. 表示された `https://...trycloudflare.com` のURLを参加者に共有
6. ホストが「ルーム作成」を押し、表示された招待リンクまたはルームコードを共有

参加者は招待リンクを開くか、同じ公開URLでルームコードを入力します。各ブラウザでユーザー名を設定してください。

## 固定URLで公開

Quick TunnelのURLは一時的です。固定URLを使うには、Cloudflareアカウントに独自ドメインを登録し、ダッシュボードの **Networking → Tunnels** からTunnelを作成します。Tunnelに公開アプリケーションのルートを追加し、`plaza.example.com` などのホスト名から `http://127.0.0.1:4173` に接続します。

Previewを起動するPowerShellで、ルートに登録したホスト名を許可してから起動します。

```powershell
$env:KOKOPLA_ALLOWED_HOSTS = 'plaza.example.com'
npm run build
npm run preview -- --host 127.0.0.1 --port 4173 --strictPort
```

Cloudflareダッシュボードに表示されるトークンで `cloudflared` をWindowsサービスとして登録すると、PC起動時にTunnelが接続します。アプリのPreviewプロセスもタスクスケジューラなどで起動時に開始する設定が必要です。固定URLはTunnelの設定で維持されますが、このPCまたはサーバーとアプリが稼働している間だけアクセスできます。常時公開するには、常時稼働するPCまたはサーバーに配置してください。

## 操作

- `W A S D`：移動
- 画面クリック：マウスで視点操作を開始（`Esc`で解除）
- 歩行中の`Space`：ジャンプ
- 飛行中の`Space`：上昇
- マウス中クリック：歩行・ノークリップ飛行を切り替え
- `F`：一人称・三人称視点を切り替え

## レンダー画像の確認

開発サーバー起動後、`http://localhost:5173/avatar-image-test.html` を開くと、仮アバターのレンダー結果を透過PNGで表示できます。確認用の画像は `output/avatar-render/avatar-render.png` に保存済みです。Chromeと開発サーバー（ポート5173）が起動している状態で `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/capture-avatar-render.ps1` を実行すると、同じフォルダのPNGを再生成できます。ページの「PNGを保存」ボタンからもダウンロードできます。

ルームは最大8人です。TunnelはWebSocketのシグナリングに使い、位置情報はWebRTC DataChannelで端末間を直接送ります。STUN接続できないネットワークではTURNサーバーが必要です。
