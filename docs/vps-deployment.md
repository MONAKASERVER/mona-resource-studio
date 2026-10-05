# KAGOYA VPS deployment

本番APIは公式サイトと同じVPSで独立したDocker Compose projectとして動作し、Caddyから `https://www.monacraft.net/studio-api` を `127.0.0.1:8810` へ転送する。

## Security and resource isolation

- PostgreSQLとRedisはhost portを公開しない。
- APIだけをloopbackの`127.0.0.1:8810`へ公開する。
- Artifact/Snapshotは`studio-data` volume内のfilesystem object storeへ保存する。
- APIとWorkerはread-only root filesystem、capability drop、PID/CPU/memory limitを使用する。
- Build concurrencyは1とし、公式サイトへの負荷を抑える。
- `.env.production`はGitへ追加せず、VPS上でmode `600`にする。

## Install/update

```bash
cd /opt/mona-resource-studio
sudo docker compose --env-file .env.production -f compose.production.yaml config --quiet
sudo docker compose --env-file .env.production -f compose.production.yaml up -d --build
sudo docker compose --env-file .env.production -f compose.production.yaml exec api node apps/api/dist/db/seed.js
curl --fail http://127.0.0.1:8810/ready
curl --fail https://www.monacraft.net/studio-api/ready
```

`seed.js`は既存の管理者ユーザーを同じユーザー名で更新するため、通常更新時には実行しない。初回作成または管理者パスワードを意図的に再設定するときだけ実行する。

## Caddy

`deploy/caddy-studio-api.caddy`のhandlerを、`www.monacraft.net`がimportするroute snippetのcatch-all `handle`より前へ追加する。適用前に必ず検証する。

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

## Backup

PostgreSQL dumpと`studio-data` volumeを同じ復旧点として保存する。Redisはqueue/presence用途でありsource of truthではない。

```bash
sudo docker compose --env-file .env.production -f compose.production.yaml exec -T postgres \
  pg_dump -U mona -d mona_resource_studio -Fc > /opt/backups/mona-resource-studio-$(date +%Y%m%d-%H%M).dump
```

更新前はDB dumpに加えて、`mona-resource-studio_studio-data` volumeをVPS外へ複製する。
