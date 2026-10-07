# 認証・権限・セキュリティ

## 認証

- passwordはArgon2idでhash化する。
- Access Tokenは15分、Refresh Tokenは30日。refreshはローテーションし、DBにはSHA-256だけを保存する。
- DesktopはPhase 1ではtokenをメモリ保持し、平文の永続保存をしない。永続ログインはTauri Stronghold導入後に有効化する。
- 本番起動時は開発用JWT secretを拒否する。
- パスキーはWebAuthnのdiscoverable credentialとして登録し、ユーザー検証を必須にする。
- WebAuthn ceremonyは`PASSKEY_ORIGIN`と`PASSKEY_RP_ID`を厳密に検証する。challengeとアプリ引き渡しtokenは5分で失効し、一度しか使用できない。
- デスクトップアプリは公式HTTPSドメインの認証ページを既定ブラウザで開く。browser tokenはURL fragmentへ置き、HTTP request・proxy access log・Refererへ送信しない。
- credentialの秘密鍵は端末側の認証器から出ない。サーバーには公開鍵、signature counter、transport、backup状態だけを保存する。

## RBAC

`owner > admin > manager > editor > viewer`。閲覧、編集、Import、メンバー管理、ロック解除、承認、Build、ReleaseをPermissionへ分解し、API routeごとにserver-sideで検証する。Ownerだけが所有権を扱える。

## Import

- ZIP 100MiB、展開後300MiB、10,000 filesを初期上限とする。
- Zip Slip、symlink相当、NUL、absolute path、drive path、危険拡張子を拒否する。
- PNGはsignatureを検査し、JSONはparse errorをProblemへ集約する。
- 実行ファイル、script、shortcutはResource Packとして受け付けない。

## Build Worker

コンテナ/低権限ユーザーで動かし、networkを既定拒否、CPU・memory・wall time・log bytesを制限する。PackSquashの引数をshell文字列連結せず、固定されたargvとして渡す。
