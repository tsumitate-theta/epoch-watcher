# epoch-watcher

Solanaのエポック切り替わりを検知し、設定ファイルに定義されたタスクを順次実行する汎用ツール。

## セットアップ

```bash
cp .env.example .env
# .env を編集して RPC URL を設定
cp epoch-watcher.config.example.json epoch-watcher.config.json
# epoch-watcher.config.json を編集してタスクを設定
```

## 設定

`epoch-watcher.config.json`（git 管理外）にタスクを定義:

```json
{
  "tasks": [
    {
      "name": "タスク名（ログ表示用）",
      "run": "node script.mjs arg1",
      "cwd": "/path/to/working/directory"
    }
  ]
}
```

| フィールド | 説明 |
|-----------|------|
| `name` | ログ表示用のラベル |
| `run` | 実行するコマンド（コマンドライン形式） |
| `cwd` | 作業ディレクトリ（省略可）。`~` はホームに展開、相対パスは本ツールのディレクトリ基準 |

引用符付きの引数も対応: `"run": "echo 'hello world'"`

タスクはRPC負荷を避けるため順次実行される。

## 環境変数

| 変数 | 説明 | デフォルト |
|------|------|-----------|
| `SOLANA_RPC_URL` | Solana RPC エンドポイント（必須） | - |
| `EPOCH_POLL_INTERVAL` | ポーリング間隔（秒） | `300` |

## 実行

```bash
node watch-epoch.mjs
```

## 動作

1. 起動時にRPCから現在のエポックを取得
2. `epoch-state.json`（自動生成）と比較
3. 初回起動時は現在のエポックを記録するのみ
4. エポック変更を検知 → 全タスクを順次実行
5. 指定間隔でポーリング継続

RPC障害やタスク失敗でもクラッシュせず継続する。

## systemdで常駐化

```ini
[Unit]
Description=Solana Epoch Watcher
After=network.target

[Service]
ExecStart=/usr/bin/node /path/to/epoch-watcher/watch-epoch.mjs
WorkingDirectory=/path/to/epoch-watcher
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```
