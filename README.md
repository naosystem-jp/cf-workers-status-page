# cf-workers-status-page

各節は日本語の後に英語を載せています。
Each section gives the Japanese text first, then the English.

自分の Cloudflare アカウントの中だけで動く、セルフホスト型の死活監視とステータスページです。Cloudflare Workers、Durable Objects、D1、Queues の上で動き、フロントエンドは Vite + React です。

- **監視**はコード（`status.config.ts`）で定義し、Worker と一緒にデプロイします。監視ごとに決めた間隔で Cloudflare のネットワークから対象のサービスをチェックし、失敗したら報告する前に再確認し、結果はすべて保存します。
- **ステータスページ**は、各コンポーネントの状態、90日間の稼働率、障害告知、メンテナンス、監視で検知した停止を表示します。英語と日本語を同梱しています。
- **通知**は、監視が停止したとき、復旧したとき、結果が届かなくなったときに Slack、Discord、Webhook へ送ります。ページに障害告知を自動で公開させることもできます。
- **管理画面**は Cloudflare Access の内側に置き、障害告知、メンテナンス、ページの見た目、通知先を管理します。

> **状況:** 0.x の版です。1.0 までは、マイナーバージョンの更新でも互換性のない変更が入ることがあります。後で予定しているもの: 外部ランナー、停止が続く間の再通知、メールでの購読、リアルタイム更新。

Self-hosted uptime monitoring and status pages that run entirely in your own Cloudflare
account, on Cloudflare Workers, Durable Objects, D1 and Queues, with a Vite + React front end.

- **Monitors** are defined in code (`status.config.ts`) and deployed with the Worker. Each one
  checks your service on its own schedule from Cloudflare's network, re-checks failures before
  it reports them, and keeps every result.
- **Status pages** show each component's state, 90 days of uptime, incidents, maintenance and
  the outages monitoring detected. English and Japanese are included.
- **Notifications** go to Slack, Discord and webhooks when a monitor goes down, recovers, or
  stops reporting. Pages can publish incidents automatically.
- **An admin UI** behind Cloudflare Access manages incidents, maintenance, page appearance and
  notification targets.

> **Status:** version 0.x. Until 1.0, a minor version may bring incompatible changes. Planned
> for later: external runners, reminders while a monitor stays down, e-mail subscriptions,
> real-time updates.

## <a id="contents"></a>目次 / Contents

- [仕組み / How it works](#how-it-works)
- [デプロイ / Deploy](#deploy)
- [設定リファレンス / Configuration reference](#configuration-reference)
- [Cloudflare Access による管理画面へのアクセス / Admin access with Cloudflare Access](#admin-access-with-cloudflare-access)
- [秘密情報 / Secrets](#secrets)
- [通知 / Notifications](#notifications)
- [監視とステータスページ / Monitoring and the status page](#monitoring-and-the-status-page)
- [Free プランか Paid プランか / Free plan or Paid plan](#free-plan-or-paid-plan)
- [既知のリスク / Known risks](#known-risks)
- [開発 / Development](#development)
- [拡張 / Extending](#extending)
- [API リファレンス / API reference](#api-reference)

## <a id="how-it-works"></a>仕組み / How it works

```
Visitors ─────────▶ static assets (status page) ─▶ public API ─▶ StatusPage DO (one per page)
                                                                      │ reads
Administrators ─▶ Cloudflare Access ─▶ admin UI, admin API ─▶ D1       ▼
                                                              Monitor DO (one per monitor)
Cron, every minute ─▶ Reconciler DO ─ starts, stops, checks ─▶   │ alarm: next check
                                                                 ├─▶ CloudflareRunner ─▶ your service
                                                                 └─▶ Queue ─▶ consumer ─▶ Slack, Discord, webhooks
```

すべてが1つの Worker（`worker/index.ts`）で、1回の手順でデプロイできます。

- **Monitor Durable Object**（監視ごとに1つ）。アラームで各チェックを `CloudflareRunner` に実行させます。`CloudflareRunner` は同じ Worker のエントリポイントで、`ctx.exports` を通して呼び出します。すべての結果と確定状態の履歴を自身の SQLite ストレージに保存し、状態が確定すると通知をキューに入れます。
- **Reconciler Durable Object.** Workers には「デプロイ時」に動くフックがありません。そこで1分ごとの Cron（と、各 isolate が最初に受けた API リクエスト）が、動いている版の ID（バージョンメタデータ）を最後に照合した版と比べ、新しい監視を開始し、削除された監視を停止します。10分ごとにすべての監視をもう一度確認し、結果が届かなくなった監視（`unknown`）を見つけます。
- **StatusPage Durable Object**（ページごとに1つ）。ページのコンポーネントの監視を読み、状態は多くても30秒に1回、履歴は多くても5分に1回だけ計算して、すべての閲覧者に同じ結果を返します。
- **D1** は、管理者が管理するもの（障害告知、メンテナンス、ページの見た目、通知先、送信の記録）を保存します。テーブルは Worker が自分で作成・更新します。
- **R2**（任意）は、管理画面からアップロードしたロゴとファビコンを保存します（[アップロードした画像と色](#uploaded-images)）。
- **Queues** は通知を届けます。メッセージは出来事1件・通知先1件ごとに1つで、最終的に失敗したものはデッドレターキューに入ります。
- **静的アセット**はステータスページ（React SPA）を配信します。管理画面の HTML は Worker に組み込まれ、管理者にだけ返します。

Everything is one Worker (`worker/index.ts`), deployed in one step:

- **Monitor Durable Object**, one per monitor. Its alarm runs each check through
  `CloudflareRunner`, an entrypoint of the same Worker called through `ctx.exports`. It stores
  every result and the confirmed state history in its SQLite storage, and queues a notification
  when a state is confirmed.
- **Reconciler Durable Object.** Workers have no "on deploy" hook, so the every-minute Cron (and
  the first API request an isolate sees) compares the running version's ID (version metadata)
  with the last one reconciled, starts new monitors and stops removed ones. Every 10 minutes it
  checks every monitor again, and it finds monitors whose results stopped arriving (`unknown`).
- **StatusPage Durable Object**, one per page. It reads the monitors of its components, computes
  the status at most every 30 seconds and the history at most every 5 minutes, for all visitors.
- **D1** holds what administrators manage: incidents, maintenance, page appearance, notification
  targets and delivery records. The Worker creates and upgrades its tables itself.
- **R2** (optional) holds the logos and favicons uploaded in the admin UI
  ([Uploaded images and colours](#uploaded-images)).
- **Queues** deliver notifications, one message per event and per target, with a dead letter
  queue for what fails for good.
- **Static assets** serve the status page (a React SPA). The admin UI's HTML is built into the
  Worker and served only to administrators.

<details>
<summary>プロジェクトの構成 / Project layout</summary>

| パス / Path | 説明 | Description |
| --- | --- | --- |
| `status.config.ts` | 監視とステータスページ（秘密情報は書かない。デプロイされ、公開されることもある） | Monitors and status pages (no secrets: it is deployed and may be public) |
| `wrangler.jsonc` | Worker、静的アセット、Durable Objects、D1、R2、Queues、Cron の設定 | Worker, static assets, Durable Objects, D1, R2, Queues and Cron configuration |
| `worker/` | Worker 本体: API のルート、Durable Objects、Cron、キューのコンシューマー | The Worker: API routes, Durable Objects, Cron, queue consumer |
| `src/` | React SPA: ステータスページ（`src/public/`）と管理画面（`src/admin/`、別のエントリ） | React SPA: the status page (`src/public/`) and the admin UI (`src/admin/`, a separate entry) |
| `shared/` | Worker と SPA で共有する型（公開 API の応答、管理 API のスキーマ） | Types shared by the Worker and the SPA (public API responses, admin API schemas) |
| `shared/i18n/` | 翻訳: `locales/*.ts`（通知、ステータスページ）、`admin/*.ts`（管理画面） | Translations: `locales/*.ts` (notifications, status page), `admin/*.ts` (admin UI) |
| `packages/core/` | インターフェース、型、設定用のヘルパー（`@naosystem/cf-workers-status-page-core`） | Interfaces, types and config helpers (`@naosystem/cf-workers-status-page-core`) |
| `packages/provider-http/` | 組み込みの HTTP チェック（`@naosystem/cf-workers-status-page-provider-http`） | Built-in HTTP check (`@naosystem/cf-workers-status-page-provider-http`) |
| `packages/auth-cloudflare-access/` | Cloudflare Access による管理者の認証 | Admin authentication with Cloudflare Access |
| `packages/notifier-slack/`, `notifier-discord/`, `notifier-webhook/` | 通知の種類 | Notifier kinds |
| `vite.admin.ts` | 管理画面のビルド時の部品と、ローカル開発用のログイン迂回 | Build-time parts of the admin UI and of the local-development sign-in bypass |
| `vite.pages.ts` | 各ページのテンプレートをステータスページの HTML に書き込む（状態が届く前の表示のため） | Writes each page's template into the status page's HTML (for what shows before the status arrives) |

</details>

## <a id="deploy"></a>デプロイ / Deploy

### <a id="requirements"></a>必要なもの / Requirements

- Cloudflare アカウント。Workers Free プランでも1日の上限の範囲で動きます（[Free プランか Paid プランか](#free-plan-or-paid-plan)を参照）。主な対象は Workers Paid プラン（月5ドル）です。
- 管理画面に [Cloudflare Access](#admin-access-with-cloudflare-access) でログインするための Cloudflare Zero Trust。
- Wrangler でのデプロイと開発には、Node.js 22.12 以降と npm。
- 管理画面からロゴやファビコンをアップロードするには、アカウントで R2 を有効にしておく必要があります（ダッシュボードの R2）。支払い方法の登録を求められることがあります。使わない場合は `wrangler.jsonc` の `r2_buckets` を削除してください（[アップロードした画像と色](#uploaded-images)）。

<!-- en -->

- A Cloudflare account. The Workers Free plan works within its daily limits (see
  [Free plan or Paid plan](#free-plan-or-paid-plan)); the Workers Paid plan ($5 a month) is the
  main target.
- Cloudflare Zero Trust, to sign in to the admin UI with
  [Cloudflare Access](#admin-access-with-cloudflare-access).
- For deploying with Wrangler and for development: Node.js 22.12 or later, and npm.
- To upload logos and favicons in the admin UI: R2 enabled on the account (R2 in the
  dashboard), which may ask for a payment method. Without it, remove `r2_buckets` from
  `wrangler.jsonc` ([Uploaded images and colours](#uploaded-images)).

### <a id="deploy-to-cloudflare-button"></a>Deploy to Cloudflare ボタン / Deploy to Cloudflare button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/naosystem-jp/cf-workers-status-page)

この[ボタン](https://developers.cloudflare.com/workers/platform/deploy-buttons/)は、このリポジトリが公開されている間だけ使えます。リポジトリをあなたの GitHub または GitLab アカウントにコピーし、1つの設定画面で Worker の名前とリソースの名前を選ばせたうえで、[Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) でビルドしてデプロイします。以後は、新しいリポジトリに push するたびに Workers Builds がビルドとデプロイをやり直します。

- **リソース.** D1 データベース、画像用の R2 バケット、通知用のキューとそのデッドレターキュー、Durable Objects は自動で作られます。マイグレーションの手順はありません。Worker は初めてデータベースを使うときに D1 のテーブルを作ります。R2 を有効にしていないアカウントでは、バケットを作れずにデプロイが失敗します。先に R2 を有効にするか、新しいリポジトリの `wrangler.jsonc` から `r2_buckets` を削除してください。
- **シークレット.** 設定画面で `NOTIFICATION_KEYS`（`.dev.vars.example` に載っています）を求められます。通知先の Webhook URL を暗号化する鍵です。`echo "k1:$(openssl rand -base64 32)"` で自分の鍵を作って貼り付け、控えを残してください。`.dev.vars.example` の例の値は、わざと正しい鍵にしていません。もしそれがシークレットに設定されると、[鍵を設定する](#secrets)まで、秘密情報を持つ通知先を保存できません。
- **ビルドとデプロイのコマンド**は、`package.json` の `build` と `deploy` スクリプトから入力済みです。`npm run deploy` はデプロイの前にもう一度ビルドするのでビルドが2回走りますが、ビルドの時間が余分にかかるだけです。
- **リソースの名前.** 1つ目のインスタンスでは既定のままにしてください。同じアカウントに別のインスタンスを置く場合は、[1つのアカウントに複数のインスタンス](#several-instances-in-one-account)を参照してください。キューの名前を変える場合、デッドレターキューの名前は `-dlq` で終わり、もう一方の名前は `-dlq` で終わってはいけません。そのうえで、新しいリポジトリの `wrangler.jsonc` が `queues.producers` と `queues.consumers` で同じ2つのキューを指しているか確認してください。

その後、新しいリポジトリの `status.config.ts` を編集して push し、[最初のデプロイの後](#after-the-first-deploy)に進んでください。

The [button](https://developers.cloudflare.com/workers/platform/deploy-buttons/) works while
this repository is public. It copies the repository into your GitHub or GitLab account, lets
you choose the Worker's name and the resource names on one setup page, then builds and deploys
with [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/), which builds
and deploys again when you push to the new repository.

- **Resources.** The D1 database, the R2 bucket for images, the notification queue and its dead
  letter queue, and the Durable Objects are created for you. There is no migration step: the
  Worker creates its D1 tables the first time it uses the database. On an account without R2
  enabled, the bucket cannot be created and the deploy fails: enable R2 first, or remove
  `r2_buckets` from `wrangler.jsonc` in the new repository.
- **Secret.** The setup page asks for `NOTIFICATION_KEYS` (listed in `.dev.vars.example`), the
  key that encrypts notification targets' webhook URLs. Paste a key of your own, made with
  `echo "k1:$(openssl rand -base64 32)"`, and keep a copy. The example value in
  `.dev.vars.example` is deliberately not a valid key: if it ends up as the secret, targets with
  secrets cannot be saved until you [set a key](#secrets).
- **Build and deploy commands** are pre-filled from the `build` and `deploy` scripts of
  `package.json`. `npm run deploy` builds again before it deploys, so the build runs twice,
  which only costs build time.
- **Resource names.** Keep the defaults for your first instance. For another instance in the
  same account, see [Several instances in one account](#several-instances-in-one-account). If
  you rename the queues, the dead letter queue's name must end in `-dlq` and the other's must
  not; then check that `wrangler.jsonc` in the new repository names the same two queues under
  `queues.producers` and `queues.consumers`.

Then edit `status.config.ts` in your new repository and push, and continue with
[After the first deploy](#after-the-first-deploy).

### <a id="deploy-with-wrangler"></a>Wrangler でデプロイ / Deploy with Wrangler

```sh
git clone https://github.com/naosystem-jp/cf-workers-status-page.git
cd cf-workers-status-page
npm ci
# status.config.ts を編集する。*.workers.dev のサブドメインを変えるなら wrangler.jsonc の `name` を変える。
# Edit status.config.ts. Change `name` in wrangler.jsonc for another *.workers.dev subdomain.
npx wrangler login
npm run deploy
echo "k1:$(openssl rand -base64 32)" | npx wrangler secret put NOTIFICATION_KEYS
```

`npm run deploy` は型チェックとビルド（`npm run build`）を行ってから `wrangler deploy` を実行し、`dist/` にあるビルドをデプロイします（Cloudflare Vite プラグインが Wrangler にその場所を教えます）。最初のデプロイで、Wrangler は `wrangler.jsonc` に書かれた D1 データベース、R2 バケット、キューを作成し（[自動プロビジョニング](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning)）、以後は名前で見つけます。`wrangler secret put` は、シークレットを入れた新しい版をすぐにデプロイします。鍵の控えを残してください（[秘密情報](#secrets)を参照）。

変更をデプロイするには、もう一度 `npm run deploy` を実行します。

`npm run deploy` type-checks and builds (`npm run build`), then runs `wrangler deploy`, which
deploys the build in `dist/` (the Cloudflare Vite plugin points Wrangler at it). On the first
deploy Wrangler creates the D1 database, the R2 bucket and the queues named in `wrangler.jsonc`
([automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/#automatic-provisioning))
and finds them by name afterwards. `wrangler secret put` deploys a new version with the secret
at once. Keep a copy of the key (see [Secrets](#secrets)).

To deploy a change, run `npm run deploy` again.

### <a id="use-the-npm-package"></a>npm パッケージで使う / Use the npm package

自分のリポジトリには設定（`status.config.ts` と `wrangler.jsonc`）だけを置き、本体は npm パッケージ [`@naosystem/cf-workers-status-page`](https://www.npmjs.com/package/@naosystem/cf-workers-status-page) から使う方法です。本体の更新は、パッケージの版を上げるだけで済みます。ひな形は `templates/starter` にあります。

```sh
git clone --depth 1 https://github.com/naosystem-jp/cf-workers-status-page.git
cp -r cf-workers-status-page/templates/starter my-status-page
cd my-status-page
npm install
# status.config.ts を編集する。wrangler.jsonc で Worker、D1、キューの名前を選ぶ。
# Edit status.config.ts. Choose the names of the Worker, the D1 database and the queues in wrangler.jsonc.
npx wrangler login
npm run deploy
echo "k1:$(openssl rand -base64 32)" | npx wrangler secret put NOTIFICATION_KEYS
```

- `wrangler.jsonc` に書くのは、Worker の名前、D1 データベース、2つのキュー、任意で R2 バケットだけです。Durable Objects、キューのコンシューマー、Cron、静的アセットは、パッケージの Vite プラグイン（`vite.config.ts` の `statusPage()`）が加えます。キューの名前の決まり（[キューの名前](#several-instances-in-one-account)）は同じです。
- [設定リファレンス](#configuration-reference)の例は、このリポジトリのパッケージから import しています。npm パッケージでは、次の名前から import します。

  | このリポジトリ | npm パッケージ |
  | --- | --- |
  | `@naosystem/cf-workers-status-page-core`, `…-provider-http` | `@naosystem/cf-workers-status-page` |
  | `@naosystem/cf-workers-status-page-notifier-slack` など | `@naosystem/cf-workers-status-page/notifier-slack`、`/notifier-discord`、`/notifier-webhook` |
  | `@naosystem/cf-workers-status-page-auth-cloudflare-access` | `@naosystem/cf-workers-status-page/auth-cloudflare-access` |

- 更新するには、`npm install @naosystem/cf-workers-status-page@latest` の後に `npm run deploy` を実行します。1.0 までは、マイナーバージョンの更新でも互換性のない変更が入ることがあります。

その後、[最初のデプロイの後](#after-the-first-deploy)に進んでください。

Keep only your configuration (`status.config.ts` and `wrangler.jsonc`) in a repository of your
own, and use the rest from the npm package
[`@naosystem/cf-workers-status-page`](https://www.npmjs.com/package/@naosystem/cf-workers-status-page):
updating is raising the package's version. The starting point is `templates/starter` (commands
above).

- `wrangler.jsonc` names only the Worker, the D1 database, the two queues and, optionally, an R2
  bucket. The package's Vite plugin (`statusPage()` in `vite.config.ts`) adds the Durable
  Objects, the queue consumers, the Cron and the static assets. The rule for queue names
  ([Queue names](#several-instances-in-one-account)) is the same.
- The examples in the [Configuration reference](#configuration-reference) import from this
  repository's packages. With the npm package, import from these instead:

  | This repository | npm package |
  | --- | --- |
  | `@naosystem/cf-workers-status-page-core`, `…-provider-http` | `@naosystem/cf-workers-status-page` |
  | `@naosystem/cf-workers-status-page-notifier-slack` and the like | `@naosystem/cf-workers-status-page/notifier-slack`, `/notifier-discord`, `/notifier-webhook` |
  | `@naosystem/cf-workers-status-page-auth-cloudflare-access` | `@naosystem/cf-workers-status-page/auth-cloudflare-access` |

- To update, run `npm install @naosystem/cf-workers-status-page@latest`, then `npm run deploy`.
  Until 1.0, a minor version may bring incompatible changes.

Then continue with [After the first deploy](#after-the-first-deploy).

### <a id="after-the-first-deploy"></a>最初のデプロイの後 / After the first deploy

1. Worker の URL（`https://cf-workers-status-page.<あなたのサブドメイン>.workers.dev/`、または追加した[カスタムドメイン](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)）を開きます。コンポーネントは、監視の最初のチェックで状態が確定するまで `unknown` と表示されます。通常は1〜2分です。
2. 管理画面の前に Cloudflare Access を置き、`auth` を設定します: [Cloudflare Access による管理画面へのアクセス](#admin-access-with-cloudflare-access)。
3. 管理画面（`/admin`）で各ページのタイトルとリンクを設定し、通知先を追加します（それぞれからテストを送ってください）。
4. 監視が `secret()` で参照する Worker のシークレットを設定します（[秘密情報](#secrets)）。
5. Cloudflare の外からハブを監視します（[既知のリスク](#known-risks)）。

<!-- en -->

1. Open the Worker's URL (`https://cf-workers-status-page.<your subdomain>.workers.dev/`, or a
   [custom domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
   you add). Components show `unknown` until their monitor's first checks have confirmed a state,
   usually within a minute or two.
2. Put Cloudflare Access in front of the admin UI and configure `auth`:
   [Admin access with Cloudflare Access](#admin-access-with-cloudflare-access).
3. In the admin UI (`/admin`), set each page's title and links, and add notification targets
   (send a test from each).
4. Set the Worker secrets your monitors reference with `secret()` ([Secrets](#secrets)).
5. Watch the hub from outside Cloudflare ([Known risks](#known-risks)).

### <a id="when-changes-take-effect"></a>変更が反映されるタイミング / When changes take effect

- **新しい監視**は、デプロイから1分以内に始まります。1分ごとの Cron か、Worker の API（`/api/*`）へのいずれかのリクエストが開始させます。
- **既存の監視の変更**（`interval` の変更、監視の削除、削除した監視の復活）は、その監視の Durable Object が新しいコードで動いた時点で反映されます。既定では、動いている Durable Object は次にアイドルになったとき、または長くても5分後に新しい版に切り替わります（[コードの更新](https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/)）。Worker は監視への反映を 1, 2, 4 … 分後に再試行するので、5〜15分ほど見込んでください。段階的デプロイの間は、その監視の Durable Object に新しい版が割り当てられた時点で変わります。
- **ページ、コンポーネント、通知の種類、文言**は、デプロイと同時に変わります。各ページの Durable Object は、タイムゾーンやルールが変わるとキャッシュを作り直します。
- **正しくない `status.config.ts`** があると、`wrangler deploy`（Worker が読み込み時に例外を投げる）と `npm run dev` が、すべての問題を列挙して失敗します。そのため本番に届くことはありません。型エラーは、その前に `npm run build` で失敗します。

<!-- en -->

- **New monitors** start within a minute of a deploy: the every-minute Cron, or any request to
  the Worker's API (`/api/*`), starts them.
- **Changes to existing monitors** (a new `interval`, removing a monitor, bringing it back) apply
  once the monitor's Durable Object runs the new code. By default an active Durable Object adopts
  a new version when it next goes idle, or after at most 5 minutes
  ([code updates](https://developers.cloudflare.com/durable-objects/deployments/durable-objects-code-updates/)),
  and the Worker tries a monitor again after 1, 2, 4 … minutes, so allow 5 to 15 minutes. During
  a gradual deployment, a monitor changes once its Durable Object is assigned the new version.
- **Pages, components, notifier kinds and texts** change with the deploy. Each page's Durable
  Object rebuilds its cache when the time zone or the rules change.
- **An invalid `status.config.ts`** fails `wrangler deploy` (the Worker throws when it loads)
  and `npm run dev`, listing every problem, so it never reaches production; type errors
  already fail `npm run build`.

### <a id="several-instances-in-one-account"></a>1つのアカウントに複数のインスタンス / Several instances in one account

2つ目のインスタンス（ステージング、別チームのページなど）を同じアカウントにデプロイするには、`wrangler.jsonc` で Worker の `name` と、D1 データベース、R2 バケット、2つのキューの名前を、それぞれ専用のものにします。たとえば次のようにします。

To deploy a second instance (staging, another team's pages) to the same account, give it its own
Worker `name` and its own names for the D1 database, the R2 bucket and both queues in
`wrangler.jsonc`, for example:

| `wrangler.jsonc` の設定 / Setting in `wrangler.jsonc` | 1つ目 / First instance | 2つ目 / Second instance |
| --- | --- | --- |
| `name` | `cf-workers-status-page` | `cf-workers-status-page-staging` |
| `d1_databases[].database_name` | `cf-workers-status-page` | `cf-workers-status-page-staging` |
| `r2_buckets[].bucket_name` | `cf-workers-status-page-uploads` | `cf-workers-status-page-staging-uploads` |
| 通知キュー / Notification queue: `queues.producers[].queue` (`NOTIFICATIONS`), `queues.consumers[0].queue` | `cf-workers-status-page-notifications` | `cf-workers-status-page-staging-notifications` |
| デッドレターキュー / Dead letter queue: `queues.producers[].queue` (`NOTIFICATIONS_DLQ`), `queues.consumers[0].dead_letter_queue`, `queues.consumers[1].queue` | `cf-workers-status-page-notifications-dlq` | `cf-workers-status-page-staging-notifications-dlq` |

- Wrangler は、同じ名前のデータベース、バケット、キューがあれば、新しく作らずにそれを使います。そうなると2つのインスタンスが、障害告知、通知先、送信の記録、画像を共有してしまいます。また、キューの[コンシューマーは1つだけ](https://developers.cloudflare.com/queues/reference/how-queues-works/)です。
- Durable Objects はその Worker に属するので、名前を変える必要はありません。
- 各インスタンスは Cron Trigger を1つ使います。Free プランではアカウントあたり5つまでです（[制限](https://developers.cloudflare.com/workers/platform/limits/#account-plan-limits)）。

**キューの名前.** 1つのコンシューマーが両方のキューを処理し、名前で見分けます。デッドレターキューの名前は `-dlq` で終わり（`<キュー名>-dlq`）、通知キューの名前は `-dlq` で終わりません。これが崩れると、通知は気付かれないまま壊れます。

- 名前が `-dlq` で終わる通知キューでは、コンシューマーはすべての通知を送らずに、送信失敗として記録します。
- 名前が `-dlq` で終わらないデッドレターキューでは、キューが諦めたものを、コンシューマーは失敗として一覧に載せず、新しいメッセージとして処理します。

`max_retries` も 20 のままにしてください（`worker/notifications/limits.ts` の `MAX_RETRIES` と合わせています）。

- Wrangler uses an existing database, bucket or queue with the same name instead of creating
  one: two instances would share incidents, notification targets, delivery records and images. A queue also has
  [only one consumer](https://developers.cloudflare.com/queues/reference/how-queues-works/).
- Durable Objects belong to their Worker, so their names need no change.
- Each instance uses one Cron Trigger; the Free plan allows 5 per account
  ([limits](https://developers.cloudflare.com/workers/platform/limits/#account-plan-limits)).

**Queue names.** One consumer handles both queues and tells them apart by name: the dead letter
queue's name ends in `-dlq` (`<queue>-dlq`), and the notification queue's does not. If that
breaks, notifications break quietly:

- a notification queue whose name ends in `-dlq` makes the consumer record every notification
  as a failed delivery without sending it;
- a dead letter queue whose name does not end in `-dlq` makes the consumer handle what the
  queue gave up on as new messages, instead of listing it as failed.

Keep `max_retries` at 20 too (it matches `MAX_RETRIES` in `worker/notifications/limits.ts`).

## <a id="configuration-reference"></a>設定リファレンス / Configuration reference

`status.config.ts` は監視とページを定義します。Worker と一緒にデプロイされ、公開リポジトリに置かれることもあります。**秘密情報は決して書かないでください**（[`secret()`](#secrets) で参照します）。また、監視する URL は、このファイルを読める人なら誰でも見られることに注意してください。Worker は読み込み時にこのファイルを検証し、すべての問題をまとめて報告します。知らないキーはエラーです。期間は整数と単位で書きます: `"500ms"`、`"15s"`、`"1m"`、`"12h"`、`"180d"`。

`status.config.ts` defines the monitors and pages. It is deployed with the Worker and may be
in a public repository: **never put secrets in it** (reference them with
[`secret()`](#secrets)), and remember that the URLs you monitor are visible to anyone who can
read it. The Worker validates it when it loads and reports every problem at once; unknown keys
are errors. Durations are an integer and a unit: `"500ms"`, `"15s"`, `"1m"`, `"12h"`, `"180d"`.

```ts
import { cloudflareAccess } from "@naosystem/cf-workers-status-page-auth-cloudflare-access";
import { component, defineConfig, secret } from "@naosystem/cf-workers-status-page-core";
import { discord } from "@naosystem/cf-workers-status-page-notifier-discord";
import { slack } from "@naosystem/cf-workers-status-page-notifier-slack";
import { webhook } from "@naosystem/cf-workers-status-page-notifier-webhook";
import { http } from "@naosystem/cf-workers-status-page-provider-http";

export default defineConfig({
	timezone: "Asia/Tokyo",
	location: "apac-ne",
	retention: "180d",
	auth: cloudflareAccess({ teamDomain: "myteam.cloudflareaccess.com", aud: "<AUD tag>", allowedDomains: ["example.com"] }),
	notifiers: [slack(), discord(), webhook()],
	locale: "en",
	baseUrl: "https://status.example.com",
	monitors: [
		http({ id: "api", name: "API", url: "https://api.example.com/health", interval: "1m" }),
		http({ id: "web", url: "https://www.example.com/", interval: "5m", headers: { Authorization: secret("WEB_TOKEN") } }),
	],
	pages: [
		{
			id: "default",
			incidents: { auto: true },
			components: [component("api"), { id: "website", name: "Website", monitors: ["web"] }, { id: "mail", name: "Mail" }],
		},
	],
});
```

### <a id="general-options"></a>全体のオプション / General options

| オプション | 既定値 | 規則と補足 |
| --- | --- | --- |
| `timezone` | `"UTC"` | IANA の名前（`"Asia/Tokyo"` など）。90日間の履歴で、各日がいつ始まるかを決めます。1日が23時間や25時間になることもあります。変えると履歴のキャッシュを作り直します。 |
| `location` | なし: Cloudflare が選ぶ | 監視がどこからチェックするか（監視ごとの指定がない場合）: `wnam`、`enam`、`sam`、`weur`、`eeur`、`apac`、`apac-ne`、`apac-se`、`oc`、`afr`、`me`。下の[地点](#location)を参照。 |
| `retention` | なし: 結果を無期限に保存 | チェック結果の保存期間。`"1d"` 以上で、かつすべての監視の `interval` の10倍以上。短くすると、古い結果が少しずつ、元に戻せない形で削除されます。 |
| `auth` | なし: 管理画面と管理 API はすべてのリクエストを拒否 | 認証プロバイダー: `cloudflareAccess({ … })`。[管理画面へのアクセス](#admin-access-with-cloudflare-access)を参照。 |
| `notifiers` | `[]` | 管理画面で選べる通知の種類: `slack()`、`discord()`、`webhook()`。各 `type` は1回まで。通知先そのものは管理画面で設定します。 |
| `locale` | `"en"` | 通知と自動告知の言語。`"ja"` のような BCP 47 のタグ。翻訳がなければ英語。 |
| `baseUrl` | なし: 通知にリンクを付けない | このデプロイの URL（`"https://status.example.com"` など）。管理者向けの通知に付く「障害告知を作成」のリンクに使います。http か https で、認証情報、クエリ、フラグメントは付けられません。 |
| `notifications.unknownCheckInterval` | `"1m"` | 結果が届かなくなった監視を Cron が探す間隔。`"1m"` から `"1h"` までの分単位。長くすると Durable Object のリクエストを節約できる代わりに、`unknown` の通知が遅れます。 |
| `publicApi.cache` | `"durable-object"` | または `"workers-cache"`。[公開 API: キャッシュと CORS](#public-api-caching-and-cors) を参照。 |
| `publicApi.allowedOrigins` | なし: CORS ヘッダーを送らない | `"*"`、または `"https://www.example.com"` のような正確なオリジン（小文字、パスや末尾のスラッシュなし、既定のポートなし）。ここに挙げたオリジンのスクリプトが公開 API を読めます。管理 API には適用されません。 |
| `monitors` | `[]` | `http({ … })` のようなプロバイダーで作ります。 |
| `pages` | `[]` | 最初のページが、`/` と `/api/status` で表示されるページです。 |
| `adminHosts` | なし: どのホスト名でも応答 | 管理画面と管理 API が応答するホスト名。`["status.example.com"]` のように書きます（小文字、ポートは 443 以外のときだけ付ける）。`"baseUrl"` なら `baseUrl` のホストです。それ以外のホストへのリクエストは、ログインの失敗と同じ `403` になります。推奨。[管理画面へのアクセス](#admin-access-with-cloudflare-access)を参照。 |

| Option | Default | Rules and notes |
| --- | --- | --- |
| `timezone` | `"UTC"` | IANA name, such as `"Asia/Tokyo"`. Where each day of the 90-day history starts; a day can be 23 or 25 hours. Changing it rebuilds the history cache. |
| `location` | none: Cloudflare chooses | Where monitors check from, unless a monitor sets its own: `wnam`, `enam`, `sam`, `weur`, `eeur`, `apac`, `apac-ne`, `apac-se`, `oc`, `afr`, `me`. See [Location](#location) below. |
| `retention` | none: keep results forever | How long check results are kept: at least `"1d"`, and at least 10 times every monitor's `interval`. Shortening it deletes older results, gradually and for good. |
| `auth` | none: the admin UI and admin API reject every request | An auth provider: `cloudflareAccess({ … })`, see [Admin access](#admin-access-with-cloudflare-access). |
| `notifiers` | `[]` | Notifier kinds offered in the admin UI: `slack()`, `discord()`, `webhook()`. Each `type` once. Targets themselves are set up in the admin UI. |
| `locale` | `"en"` | Language of notifications and automatic incidents, a BCP 47 tag such as `"ja"`. Without a translation, English. |
| `baseUrl` | none: notifications carry no links | This deployment's URL, such as `"https://status.example.com"`, for the "create an incident" link in administrators' notifications. http or https, without credentials, query or fragment. |
| `notifications.unknownCheckInterval` | `"1m"` | How often the Cron looks for monitors whose results stopped arriving: whole minutes from `"1m"` to `"1h"`. Longer saves Durable Object requests and delays `unknown` notifications. |
| `publicApi.cache` | `"durable-object"` | Or `"workers-cache"`. See [Public API: caching and CORS](#public-api-caching-and-cors). |
| `publicApi.allowedOrigins` | none: no CORS headers | `"*"`, or exact origins such as `"https://www.example.com"` (lowercase, no path or trailing slash, no default port), whose scripts may read the public API. Never applies to the admin API. |
| `monitors` | `[]` | Created by a provider, such as `http({ … })`. |
| `pages` | `[]` | The first page is the one at `/` and `/api/status`. |
| `adminHosts` | none: any host name | Host names on which the admin UI and admin API answer, such as `["status.example.com"]` (lowercase, with a port only if it is not 443), or `"baseUrl"` for the host of `baseUrl`. Requests for any other host get the same `403` as a failed sign-in. Recommended; see [Admin access](#admin-access-with-cloudflare-access). |

#### <a id="location"></a>地点 / Location

監視は、`location` の近くに作られた Durable Object で動きます。`location` は[ロケーションヒント](https://developers.cloudflare.com/durable-objects/reference/data-location/#provide-a-location-hint)なのでベストエフォートで、`sam`、`afr`、`me` は現在、近くの別の地域に置かれます。**Durable Object は移動しません。** 後から `location` を変えても既存の監視には効きません（Worker は警告をログに出します）。別の地点からチェックするには、監視に新しい `id` を付けてください。履歴は最初からになります。

A monitor runs in a Durable Object created near its `location`, which is a
[location hint](https://developers.cloudflare.com/durable-objects/reference/data-location/#provide-a-location-hint):
best effort, and `sam`, `afr` and `me` currently land in a nearby region. **A Durable Object
never moves**: changing `location` later has no effect on an existing monitor (the Worker logs a
warning). To check from another location, give the monitor a new `id`; its history starts over.

### <a id="monitors"></a>監視 / Monitors

プロバイダーにかかわらず、すべての監視が持つ設定:

| 設定 | 既定値 | 規則と補足 |
| --- | --- | --- |
| `id` | 必須 | 1〜64文字の小文字の英字、数字、`-`、`_` で、英字か数字で始まる。重複不可。監視の Durable Object の名前になるので、新しい `id` は履歴が空の新しい監視になります。 |
| `name` | `id` | 表示名。管理画面と通知で使い、この監視1つだけを持つコンポーネントの名前にもなります。 |
| `interval` | 必須 | 予定したチェックの間隔（`"1m"` など）。`retention` の10分の1以下。 |
| `timeout` | `"10s"` | チェックにかけられる時間。これを超えると `down` として数えます。`interval` より短く、`"5m"` 以下。 |
| `location` | 設定全体の `location` | [地点](#location)を参照。 |
| `confirmation.failureThreshold` | `2` | `down`（または `degraded`）を確定させる、連続した失敗の回数。1以上の整数。 |
| `confirmation.successThreshold` | `1` | `up` を確定させる、連続した成功の回数。1以上の整数。 |
| `confirmation.recheckInterval` | `"15s"` | 失敗したチェックを、次の間隔を待たずにどれだけ早く再確認するか。`interval` 以下。 |

`runner`、`runners`、`enabled`、`description`、`tags` は、将来の設定のために予約されています。

組み込みの **HTTP チェック**（`@naosystem/cf-workers-status-page-provider-http` の `http({ … })`）は、上の設定に加えて次のオプションを取ります:

| オプション | 既定値 | 規則と補足 |
| --- | --- | --- |
| `url` | 必須 | http か https。認証情報は付けられません（`https://user:pass@…` は拒否）。 |
| `method` | `"GET"` | `GET`、`HEAD`、`POST`、`PUT`、`PATCH`、`DELETE`、`OPTIONS` のいずれか。 |
| `headers` | なし | 値は文字列か `secret("NAME")`。`Authorization`、`Proxy-Authorization`、`Cookie` には `secret()` が必須です。`secret()` を使うヘッダーがあれば、`url` は https でなければなりません（下を参照）。 |
| `body` | なし | `GET` と `HEAD` では使えません。 |
| `expectedStatus` | `"2xx"` | ステータスコード（`204`）、クラス（`"3xx"`）、またはそれらのリスト。 |
| `followRedirects` | `true` | `false` にすると、リダイレクトの応答をそのまま判定します。 |

チェックは、ステータスが期待どおりなら `up`、そうでなければ `down` です。ネットワークエラーとタイムアウトも `down` になります。HTTP チェックが `degraded` を報告することはありません。レイテンシーは応答ヘッダーが届くまでの時間で、本文は読みません。`headers` で指定しない限り、リクエストには `User-Agent: Mozilla/5.0 (compatible; cf-workers-status-page; +https://github.com/naosystem-jp/cf-workers-status-page)` が付きます。

**`secret()` ヘッダーを使うチェックのリダイレクト.** このようなリクエストは平文の http では決して送らず、リダイレクトは https の同じオリジンの中だけを（最大20回）たどります。別のオリジン（または http）へのリダイレクトはたどらず、リダイレクトの応答そのものを `expectedStatus` で判定します。そのため既定の `"2xx"` では監視は `down` になり、リダイレクトをたどらなかったことと、その理由がメッセージに書かれます。最終的な URL を監視するか、そのリダイレクトが想定どおりなら `expectedStatus: "3xx"` を指定してください。秘密情報を含まないチェックは、通常どおりリダイレクトをたどります。

Settings every monitor has, whatever its provider:

| Setting | Default | Rules and notes |
| --- | --- | --- |
| `id` | required | 1-64 lowercase letters, digits, `-` and `_`, starting with a letter or digit; unique. It names the monitor's Durable Object: a new `id` is a new monitor with an empty history. |
| `name` | the `id` | Display name, in the admin UI and notifications, and for a component with this one monitor. |
| `interval` | required | Time between scheduled checks, such as `"1m"`. At most a tenth of `retention`. |
| `timeout` | `"10s"` | How long a check may take before it counts as `down`. Shorter than `interval`, and at most `"5m"`. |
| `location` | the configuration's `location` | See [Location](#location). |
| `confirmation.failureThreshold` | `2` | Consecutive failed checks that confirm `down` (or `degraded`). Integer, at least 1. |
| `confirmation.successThreshold` | `1` | Consecutive successful checks that confirm `up`. Integer, at least 1. |
| `confirmation.recheckInterval` | `"15s"` | How soon a failed check is checked again, instead of waiting for the next interval. Not longer than `interval`. |

`runner`, `runners`, `enabled`, `description` and `tags` are reserved for future settings.

The built-in **HTTP check**, `http({ … })` from
`@naosystem/cf-workers-status-page-provider-http`, takes these options next to the settings:

| Option | Default | Rules and notes |
| --- | --- | --- |
| `url` | required | http or https, without credentials (`https://user:pass@…` is rejected). |
| `method` | `"GET"` | `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE` or `OPTIONS`. |
| `headers` | none | Values are strings or `secret("NAME")`. `Authorization`, `Proxy-Authorization` and `Cookie` must use `secret()`. With any `secret()` header, `url` must be https (see below). |
| `body` | none | Not with `GET` or `HEAD`. |
| `expectedStatus` | `"2xx"` | A status code (`204`), a class (`"3xx"`) or a list of them. |
| `followRedirects` | `true` | With `false`, a redirect is judged as it is. |

A check is `up` when the status is expected and `down` otherwise, including network errors and
timeouts; the HTTP check never reports `degraded`. Its latency is the time until the response
headers arrive; the body is not read. Requests carry
`User-Agent: Mozilla/5.0 (compatible; cf-workers-status-page; +https://github.com/naosystem-jp/cf-workers-status-page)`
unless `headers` sets one.

**Redirects of a check with `secret()` headers.** Such a request is never sent over plain http,
and its redirects are followed (at most 20) only within the same origin over https. A redirect
to another origin (or to http) is not followed: the redirect response itself is judged against
`expectedStatus`, so with the default `"2xx"` the monitor is `down`, with a message that says the
redirect was not followed and why. Point the monitor at the final URL, or set
`expectedStatus: "3xx"` if the redirect is what you expect. Checks without secrets follow
redirects as usual.

### <a id="pages-and-components"></a>ページとコンポーネント / Pages and components

| 設定 | 既定値 | 規則と補足 |
| --- | --- | --- |
| `pages[].id` | 必須 | 監視 ID と同じ規則。重複不可。URL では `/pages/:pageId`。 |
| `pages[].template` | `"default"` | ページの見た目。`"default"` または `"modern"`。[テンプレート](#templates)を参照。 |
| `pages[].reportUrl` | なし | 閲覧者が問題を報告する先。`https:`、`http:`、`mailto:` の URL。モダンテンプレートのヘッダーに「問題を報告」として表示します。 |
| `pages[].incidents.auto` | `false` | 障害告知を自動で公開します。[自動告知](#automatic-incidents)を参照。 |
| `pages[].incidents.templates` | 翻訳の文面 | 自動告知の文面。 |
| `pages[].incidents.reopenWithin` | `"30m"` | 自動で解決した告知について、その後どれだけの間なら、同じコンポーネントの新たな `down` で別の告知を公開せずに、その告知を再開するか。`"1d"` まで。`"0m"` で無効になります。 |
| `pages[].components` | `[]` | ページに並べるもの（この順で表示）。コンポーネントと、コンポーネントのグループ。 |
| `components[].id` | 必須 | 監視 ID と同じ規則。ページ内で重複不可（グループの ID とも）。障害告知とメンテナンスはコンポーネントを ID で参照するので、コンポーネントの名前を変えるときも ID は変えないでください。 |
| `components[].name` | 監視がちょうど1つのコンポーネントでは、その監視の名前 | それ以外では必須。 |
| `components[].monitors` | `[]` | 監視 ID（それぞれ1回まで）。コンポーネントは、それらの状態のうち最も悪いものを表示します。監視がなければ、状態は障害告知だけで決まります。 |
| `components[].latency` | `false` | 監視の応答時間を公開します。監視が1つ以上必要です。モダンテンプレートが表示します。[テンプレート](#templates)を参照。 |
| グループ: `{ id, name, components }` | — | 名前の下にまとめて折りたたむコンポーネント（1つ以上。グループは入れ子にできません）。表示のためだけのもので、障害告知、メンテナンス、履歴はコンポーネントごとのままです。モダンテンプレートが表示し、デフォルトテンプレートはコンポーネントを1つずつ並べます。 |

`component("api")` は、監視 `api` 1つだけを持ち、同じ `id` とその監視の名前を持つコンポーネントです（名前を変えるには `component("api", { name: "API" })`）。**どのコンポーネントにも入っていない監視は公開されません。** どのページにも、公開 API のどの応答にも現れません。

| Setting | Default | Rules and notes |
| --- | --- | --- |
| `pages[].id` | required | Same rules as monitor IDs; unique. In URLs: `/pages/:pageId`. |
| `pages[].template` | `"default"` | How the page looks: `"default"` or `"modern"`; see [Templates](#templates). |
| `pages[].reportUrl` | none | Where visitors report a problem: an `https:`, `http:` or `mailto:` URL, linked as "Report a problem" in the modern template's header. |
| `pages[].incidents.auto` | `false` | Publish incidents automatically; see [Automatic incidents](#automatic-incidents). |
| `pages[].incidents.templates` | the translations | Texts of automatic incidents. |
| `pages[].incidents.reopenWithin` | `"30m"` | How long after automation resolved an incident a new `down` of the same components reopens it instead of publishing another. At most `"1d"`; `"0m"` turns it off. |
| `pages[].components` | `[]` | What the page lists, in order: components, and groups of components. |
| `components[].id` | required | Same rules as monitor IDs; unique within the page (groups included). Incidents and maintenance refer to components by ID: keep it when you rename a component. |
| `components[].name` | the monitor's name, for a component with exactly one monitor | Required otherwise. |
| `components[].monitors` | `[]` | Monitor IDs, each once. The component shows the worst of their states. Without monitors, only incidents set its state. |
| `components[].latency` | `false` | Publish its monitors' response times. Needs at least one monitor. Shown by the modern template; see [Templates](#templates). |
| A group: `{ id, name, components }` | — | Components folded under one name (at least one; groups do not nest). Display only: incidents, maintenance and history stay per component. Shown by the modern template; the default template lists the components one by one. |

`component("api")` is a component with the one monitor `api`, the same `id` and the monitor's
name (`component("api", { name: "API" })` to rename it). **Monitors in no component are not
public**: no page or public API response mentions them.

#### <a id="templates"></a>テンプレート / Templates

ページの見た目は `pages[].template` で選びます。どちらのテンプレートも同じ[公開 API](#public-api) を同じ間隔で読み、同じ状態、障害告知、メンテナンス、90日間のバーを表示します。

- **`"default"`（既定）.** 全体の状態のバナー、障害告知、メンテナンス、コンポーネントとそのバー、過去の障害告知、監視で検知した停止を、1つのページに縦に並べます。ライトとダークはシステムの設定に従います。
- **`"modern"`.** 暗い色のヘッダーの下に、1枚のカードで表示します。コンポーネントのグループ（折りたたみ）、日ごとのバーの中の停止・性能低下・メンテナンスの時間の割合、日ごとのツールチップ（その日の障害告知、メンテナンス、監視で検知した停止とその時刻）、応答時間（`latency: true` のコンポーネント）、過去7日間の障害告知、ヘッダーの「問題を報告」（`reportUrl`）、フッターのライト／ダークの切り替えがあります。過去の障害告知と検知した停止は、`/pages/:pageId/history` に分けて表示します。フォントは Inter と Noto Sans JP（SIL Open Font License 1.1）をページと一緒に配信します。ほかのサイトからは読み込まず、使う文字の分だけをダウンロードします。モダンテンプレートのコード、スタイル、フォントは、モダンテンプレートのページを開いたときだけ読み込みます。

**状態が届く前の表示.** ビルドのとき（`npm run dev` でも）、`status.config.ts` から各ページのテンプレートを読み、ステータスページの HTML に書き込みます（`<meta name="cf-workers-status-page:templates" content="default:modern">`。ページの ID は、もともと `GET /api/pages` で公開されています）。そのため、公開 API の応答を待つ間の「読み込み中」と、最初の読み込みに失敗したときの表示も、ページ自身のテンプレートで表示します。タイトルとロゴは管理画面の設定なので、状態が届いてから表示します。`status.config.ts` を読めなかったときは警告を出して書き込まず、ページは状態が届くまで、デフォルトのテンプレートで「読み込み中」と表示します。

**応答時間.** `latency: true` のコンポーネントは、監視の応答時間を `GET /api/pages/:pageId/latency` で公開します。最新のチェックの値、直近24時間（15分ごと）、7日間（2時間ごと）、30日間（6時間ごと）の平均と、各期間の平均と95パーセンタイルです。数えるのは、応答があった予定のチェックだけです（再確認、タイムアウト、接続の失敗は含みません）。95パーセンタイルはヒストグラムからの推定値で、誤差は約5%以内です。コンポーネントに監視が複数あれば、すべての監視のチェックをまとめて数えます。値は、ページが履歴のために Monitor DO から読む結果の行から集計し、日ごとの値のキャッシュと一緒に StatusPage DO に保存します。そのため、Durable Object へのリクエストも、読み取り行数も増えません。チェックのたびに何かを書き込むこともありません。応答時間を公開するページは、30日分の集計（監視1件・1日あたり数KB）をメモリと SQLite に持ちます。

```ts
{
	id: "default",
	template: "modern",
	reportUrl: "mailto:support@example.com",
	components: [
		component("api", { name: "API", latency: true }),
		{ id: "notify", name: "通知 / Notifications", components: [component("mail"), component("hooks")] },
	],
},
```

Choose how a page looks with `pages[].template`. Both templates read the same
[public API](#public-api) at the same pace and show the same states, incidents, maintenance and 90
days of bars.

- **`"default"`** lists, one under another on one page, the overall banner, incidents,
  maintenance, the components with their bars, past incidents and the outages monitoring
  detected. Light and dark follow the system.
- **`"modern"`** shows one card under a dark header: groups of components (folded), the share of
  each day spent down, degraded and in maintenance inside its bar, a tooltip per day with that
  day's incidents, maintenance and detected outages at their times, response times (components
  with `latency: true`), the incidents of the past 7 days, "Report a problem" in the header
  (`reportUrl`) and a light/dark switch in the footer. Past incidents and detected outages are on
  `/pages/:pageId/history`. Its fonts, Inter and Noto Sans JP (SIL Open Font License 1.1), are
  served with the page, never from other sites, and only the characters a page uses are
  downloaded. The modern template's code, styles and fonts load only when one of its pages opens.

**Before the status arrives.** A build (and `npm run dev`) reads each page's template from
`status.config.ts` and writes it into the status page's HTML
(`<meta name="cf-workers-status-page:templates" content="default:modern">`; page IDs are public
already, at `GET /api/pages`). A page therefore shows "Loading" while it waits for the public API,
and a first failure to load, in its own template. Its title and logo, set in the admin UI, show
once the status has arrived. When `status.config.ts` cannot be read, the build warns and writes
nothing: pages then show "Loading" in the default template until their status arrives.

**Response times.** Components with `latency: true` publish their monitors' response times at
`GET /api/pages/:pageId/latency`: the latest check's, averages over the last 24 hours (every 15
minutes), 7 days (every 2 hours) and 30 days (every 6 hours), and each period's average and 95th
percentile. Only scheduled checks that got a response count (not re-checks, timeouts or failed
connections). The 95th percentile is estimated from a histogram, within about 5%. A component
with several monitors counts the checks of all of them. They are summed from the result rows the
page reads from the Monitor DOs for its history anyway, and kept with its daily values cache in
the StatusPage DO: no more Durable Object requests, no more rows read, and nothing written per
check. A page that publishes response times keeps 30 days of them (a few KB per monitor per day)
in memory and SQLite.

#### <a id="automatic-incidents"></a>自動告知 / Automatic incidents

`incidents: { auto: true }` にすると、`down` が確定したとき、その監視を表示するページ上のコンポーネントについて「調査中」の障害告知を公開します。それらのコンポーネントのどれかに未解決の告知があれば、新しく作らずに、その告知に経過を追加します。部分的な復旧（`down` から `degraded`）では経過を追加し、告知は開いたままにします。監視が `up` に戻ったとき、または停止中・性能低下中に `status.config.ts` から外れたとき、自動で作った告知は解決されます。ただし、管理者が編集した告知（これは自動では決して解決しません）と、告知に含まれる別の監視がまだ停止中・性能低下中の告知は除きます。メンテナンス中は自動告知を公開しません。

**状態が揺れるサービス.** 自動で告知を解決してから `reopenWithin`（既定30分）が経たないうちにコンポーネントが再び停止し、そのコンポーネントのほかの告知がどれも未解決でなければ、新しい告知は公開せず、その告知に経過（状況「調査中」）を追加して再開します。こうして、停止と復旧を繰り返すサービスでページが告知で埋まるのを防ぎます。再開するのは、自動で作られて自動で解決され、管理者が一度も編集・更新・解決していない告知だけです。

`auto` がない場合は、`down` を知らせる管理者向けの通知に、そのページとコンポーネントを指定した管理画面の障害告知フォームへのリンクが付きます（`baseUrl` を設定している場合）。どちらの場合も、ページには、監視で検知した停止が障害告知とは別に並びます。

文面は翻訳（`locale`）から取るか、下の例のように `templates` で指定します。`title` は200文字まで、それ以外の文面は2,000文字までです。使えるプレースホルダーは、`{components}`（影響を受けるコンポーネントの名前）、`{monitor}`（監視の名前。監視は公開しないものなので、既定の文面は監視の名前を出しません）、`{time}`（`timezone` での時刻）です。それ以外の `{…}` はエラーです。

With `incidents: { auto: true }`, a confirmed `down` publishes an incident at stage
"investigating" for the page's components that show the monitor, or adds an update to an
unresolved incident of one of those components. A partial recovery (from `down` to `degraded`)
adds an update and leaves the incident open; when the monitor is back `up`, or leaves
`status.config.ts` while down or degraded, an incident that automation created is resolved,
unless an administrator edited it (those are never resolved automatically) or another monitor in
it is still down or degraded. No automatic incident is published during maintenance.

**Flapping services.** When a component goes down again less than `reopenWithin` (default 30
minutes) after automation resolved its incident, and no other incident of its components is
unresolved, that incident is reopened with an update (stage "investigating") instead of a new
one being published, so that a flapping service does not fill the page with incidents. Only an
incident that automation created and resolved, and that no administrator ever edited, updated or
resolved, is reopened.

Without `auto`, administrators' notifications of a `down` link to the admin UI's incident form
for that page and its components (when `baseUrl` is set). Either way, the page lists the outages
monitoring detected apart from incidents.

The texts come from the translations (`locale`), or from `templates` as below. The title takes
at most 200 characters, the other texts at most 2,000. Placeholders: `{components}` (the
affected components' names), `{monitor}` (the monitor's name; the default texts never name
monitors, which are not public) and `{time}` (in `timezone`). Any other `{…}` is an error.

```ts
incidents: {
	auto: true,
	templates: {
		title: "{components}: service disruption", // 200文字まで / at most 200 characters
		investigating: "We are looking into an outage of {components} since {time}.",
		update: "{components} is also down since {time}.",
		partial: "{components} is partly back since {time} but still degraded.",
		resolved: "{components} recovered at {time}.",
		stopped: "Monitoring of {components} stopped at {time}.",
		reopened: "{components} is down again since {time}; we reopened this incident.",
	},
},
```

### <a id="public-api-caching-and-cors"></a>公開 API: キャッシュと CORS / Public API: caching and CORS

各ページの Durable Object は、状態を多くても30秒に1回、履歴と停止の一覧を多くても5分に1回だけ計算してすべての閲覧者に返し、管理者が障害告知、メンテナンス、見た目を変えるとすぐに破棄します。ページの一覧と障害告知は、Worker が D1 から読みます。さらに各 Worker isolate も応答を最大30秒保持するので、同じ閲覧者（やスクリプト）が繰り返し問い合わせても Durable Object には届きません。`publicApi.cache` で、その前段に何を置くかを選びます:

| | `"durable-object"`（既定） | `"workers-cache"` |
| --- | --- | --- |
| API 呼び出し1回あたり | Worker のリクエスト1回。isolate が応答を持っていなければ、Durable Object のリクエスト1回（ページの一覧と障害告知では、代わりに D1） | キャッシュの有無にかかわらず Worker のリクエスト2回（Worker 本体と、`ctx.exports` を通して呼ぶキャッシュ付きの `PublicApi` エントリポイント）。Durable Object のリクエストはキャッシュミスのときだけ |
| 管理者が変更した後 | Durable Object はすぐに反映。古い応答を持っている isolate は、最大30秒それを表示 | Cloudflare の[パージの制限](https://developers.cloudflare.com/workers/cache/purge/#rate-limits)（アカウントあたり1分に5回、バースト25回）の範囲で、全体から削除。パージが拒否されたエントリは30秒以内に期限切れになる |
| 上限 | Durable Object のリクエストは、閲覧者を受け持つ isolate の数に比例して増える。ページのオブジェクト1つで秒間約1,000リクエストまで | [Workers Cache](https://developers.cloudflare.com/workers/cache/)（階層型、全世界）。閲覧者のリクエストはキャッシュで止まる |
| `Cache-Control` | `private, no-cache`: ブラウザはポーリングのたびに問い合わせる | `public, max-age=` に30秒の残り。`stale-if-error=0` を付けて、エラーが古い「すべて正常」の陰に隠れないようにする |

どちらの設定も同じコードで動きます。`wrangler.jsonc` は常に `PublicApi` エントリポイントだけに Workers Cache を有効にしており、既定のモードでは何もそれを呼び出しません。Cloudflare の[料金](https://developers.cloudflare.com/workers/platform/pricing/)のページには、Workers Cache を有効にすると、キャッシュから返したリクエストも標準料金で課金され、静的アセットやエントリポイント間の呼び出しも含まれる、と書かれています。名前を指定した1つのエントリポイントだけでキャッシュを有効にした場合に、それが静的アセットにも当てはまるかどうかは書かれていません。これが気になる場合は、`"durable-object"` を使う間は `wrangler.jsonc` から `exports.PublicApi` を削除してください。

既定では、公開 API は CORS ヘッダーを送らないので、ブラウザから読めるのは同じサイトのページだけです。`publicApi.allowedOrigins` を設定すると、ほかのサイトのスクリプトも読めるようになります（`GET`、`HEAD`、プリフライトの `OPTIONS`）。

Each page's Durable Object computes its status at most every 30 seconds and its history and
stoppages at most every 5 minutes, for all visitors, and drops them as soon as an administrator
changes incidents, maintenance or appearance. The list of pages and incidents are read from D1
by the Worker. Each Worker isolate also keeps responses for up to 30 seconds, so that a visitor
(or a script) asking again and again does not reach the Durable Object. `publicApi.cache`
chooses what sits in front:

| | `"durable-object"` (default) | `"workers-cache"` |
| --- | --- | --- |
| Per API call | 1 Worker request, and 1 Durable Object request when the isolate does not have the response (D1 instead for pages and incidents) | 2 Worker requests (the Worker, and its cached `PublicApi` entrypoint through `ctx.exports`), cached or not; Durable Object requests only on a cache miss |
| After an administrator's change | Shown at once by the Durable Object; isolates that kept the old response show it for up to 30 seconds | Purged everywhere, within Cloudflare's [purge limit](https://developers.cloudflare.com/workers/cache/purge/#rate-limits) (5 a minute, bursts of 25, per account); a refused purge leaves entries to expire within 30 seconds |
| Limits | Durable Object requests grow with the number of isolates serving visitors; a page's object handles about 1,000 requests a second | [Workers Cache](https://developers.cloudflare.com/workers/cache/), tiered and global: visitors stop at the cache |
| `Cache-Control` | `private, no-cache`: browsers ask again on every poll | `public, max-age=` the rest of the 30 seconds, with `stale-if-error=0` so that an error is never hidden behind an old "all up" |

Both settings run the same code: `wrangler.jsonc` always enables Workers Cache for the
`PublicApi` entrypoint only, and in the default mode nothing calls it. Cloudflare's
[pricing](https://developers.cloudflare.com/workers/platform/pricing/) says that with Workers
Cache enabled, requests are billed at the standard rate even when served from the cache,
including static assets and calls between entrypoints; it does not say whether that applies to
static assets when caching is enabled for one named entrypoint only. If that matters to you,
remove `exports.PublicApi` from `wrangler.jsonc` while you use `"durable-object"`.

By default the public API sends no CORS headers, so only pages on its own site can read it from
a browser. `publicApi.allowedOrigins` lets other sites' scripts read it (`GET`, `HEAD`, and
preflight `OPTIONS`).

## <a id="admin-access-with-cloudflare-access"></a>Cloudflare Access による管理画面へのアクセス / Admin access with Cloudflare Access

管理画面（`/admin`）と管理 API（`/api/admin/*`）は管理者専用です。`status.config.ts` に `auth` がなければ、すべてのリクエストを拒否します。

1. Cloudflare ダッシュボードで **Zero Trust** → **Access controls** → **Applications** → **Create new application** → **Self-hosted and private** に進み、Worker のホスト名（`cf-workers-status-page.<あなたのサブドメイン>.workers.dev` またはカスタムドメイン）を、パス `admin` と `api/admin` で2回追加します（[ホスト名やパスを保護する](https://developers.cloudflare.com/workers/configuration/cloudflare-access/#protect-a-specific-hostname-custom-domain-or-path)。パスはその下のパスも含みます。[アプリケーションのパス](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)）。保護するのはこの2つのパスだけにして、ホストや Worker 全体は保護しないでください。ステータスページは公開のままにする必要があります。
2. 管理者を許可するポリシーを追加します（スクリプト用には、[サービストークン](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)を使う Service Auth ポリシーも追加します）。
3. アプリケーションの **Application Audience (AUD) Tag**（アプリケーションを編集 → **Additional settings**）と、チームドメイン（`<team>.cloudflareaccess.com`）をコピーします。
4. 下の例のように `status.config.ts` に設定して（どれも秘密ではありません）、デプロイします。

The admin UI (`/admin`) and the admin API (`/api/admin/*`) are for administrators only. Without
`auth` in `status.config.ts`, they reject every request.

1. In the Cloudflare dashboard, go to **Zero Trust** → **Access controls** → **Applications** →
   **Create new application** → **Self-hosted and private**, and add the Worker's host name
   (`cf-workers-status-page.<your subdomain>.workers.dev`, or your custom domain) twice, with
   the paths `admin` and `api/admin`
   ([protect a hostname or path](https://developers.cloudflare.com/workers/configuration/cloudflare-access/#protect-a-specific-hostname-custom-domain-or-path);
   a path also covers the paths under it,
   [application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)).
   Protect only these paths, not the host or the Worker as a whole: the status page must stay
   open.
2. Add a policy that allows your administrators (and, for scripts, a Service Auth policy with a
   [service token](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)).
3. Copy the application's **Application Audience (AUD) Tag** (edit the application →
   **Additional settings**) and your team domain (`<team>.cloudflareaccess.com`).
4. Configure them in `status.config.ts` as below (none of this is secret) and deploy.

```ts
import { cloudflareAccess } from "@naosystem/cf-workers-status-page-auth-cloudflare-access";

export default defineConfig({
	auth: cloudflareAccess({
		teamDomain: "myteam.cloudflareaccess.com",
		// 複数のアプリケーションでパスを保護する場合はリストにする / or a list, when several applications protect the paths
		aud: "<AUD tag>",
		// 推奨: 管理できる人。Worker がもう一度確認する。
		// Recommended: who may administer, checked again by the Worker.
		allowedDomains: ["example.com"],
		// allowedEmails: ["ops@partner.example"],
		// allowedServiceTokens: ["<client ID>.access"],
	}),
	// 推奨: 管理画面への要求には、このホストでだけ応答する。
	// Recommended: answer admin requests on this host only.
	adminHosts: ["status.example.com"], // または / or "baseUrl"
	// …
});
```

**管理画面をそのホストに限定する（推奨）.** Worker には、カスタムドメイン、`*.workers.dev` の URL、プレビュー URL など、複数のホスト名で届くことがよくあります。Access が保護していないホストでも、リクエストには有効な Access トークンが必要です。しかし漏れたトークンがあれば、Access がセッションを取り消した後でも、期限が切れるまではそのホストで受け付けられてしまいます。`adminHosts` を設定すると、管理画面と管理 API は挙げたホスト（`"baseUrl"` なら `baseUrl` のホスト）でだけ応答し、ほかのホストはすべてログインの失敗と同じ `403` になります。カスタムドメインを使う場合は、`wrangler.jsonc` で `"workers_dev": false` と `"preview_urls": false` を指定してほかのホスト名を無効にするか（[設定](https://developers.cloudflare.com/workers/wrangler/configuration/)）、`workers.dev` のホストの前にも Access を置いてください。

**Worker も確認する理由.** 静的アセットを配信する Worker は `ctx.access` を受け取れません（[Cloudflare の注記](https://developers.cloudflare.com/workers/configuration/cloudflare-access/#ctxaccess-limitations)）。また、Access の設定を誤っても、管理 API が開いてしまってはいけません。そのため Worker は、パスを見る前に、すべての管理用リクエストの `Cf-Access-Jwt-Assertion` トークンを自分で検証します。チームの鍵（`https://<チームドメイン>/cdn-cgi/access/certs`）による RS256 署名、発行者、オーディエンス、有効期限を確認します。鍵はキャッシュして5分ごとに更新し、取得できないときは最大1時間まで使い続け、それを過ぎるとすべてのリクエストを拒否します。どの失敗も同じ `403` です。

**許可リスト（推奨）.** `allowedEmails` と `allowedDomains` の一方または両方を設定してください（ドメインは完全一致で、サブドメインは含みません）。そうすれば、Access のポリシーが意図より多くの人を通しても（たとえば Google アカウントを持つ全員）、その人たちは管理者になりません。どれかのリストを設定した場合、サービストークンは、`allowedServiceTokens` にクライアント ID が載っているときだけ受け付けます。リストを1つも設定しなければ、Access アプリケーションが通した全員が管理者になり、サービストークンも含まれます。作成者はメールアドレスで、サービストークンの場合はクライアント ID で記録します。

**サイトをまたぐリクエストは拒否します.** 管理 API は、変更を同じオリジンからの `Content-Type: application/json` のリクエストとしてだけ受け付けます（ブラウザの `Sec-Fetch-Site` と `Origin` ヘッダーを確認します）。ブラウザ以外のクライアントはどちらのヘッダーも送らないので、受け付けます。管理画面はキャッシュされず、フレームに埋め込まれず、検索エンジンに登録されません。HTML には、自身のスクリプト、スタイル、API だけを許可する Content-Security-Policy が付きます。`/assets/` の下のスクリプトとスタイルは、ステータスページのものと同じく公開ファイルです。このプロジェクトのオープンソースのコードで、データは含みません。

スクリプトは、下のようにサービストークンでログインします。

**Restrict the admin to its host (recommended).** A Worker is often reachable on several host
names: a custom domain, its `*.workers.dev` URL, and preview URLs. On a host that Access does not
protect, a request still needs a valid Access token, but a leaked one would be accepted there
until it expires, even after Access revoked the session. With `adminHosts`, the admin UI and admin
API answer only on the hosts you list (`"baseUrl"`: the host of `baseUrl`); every other host gets
the same `403` as a failed sign-in. With a custom domain, also turn off the other host names in
`wrangler.jsonc` with `"workers_dev": false` and `"preview_urls": false`
([configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)), or put
Access in front of the `workers.dev` host too.

**Why the Worker checks too.** A Worker that serves static assets does not receive `ctx.access`
([Cloudflare's note](https://developers.cloudflare.com/workers/configuration/cloudflare-access/#ctxaccess-limitations)),
and a mistake in the Access settings must not open the admin API. So the Worker verifies the
`Cf-Access-Jwt-Assertion` token of every admin request itself, before it looks at the path: the
RS256 signature against your team's keys (`https://<team domain>/cdn-cgi/access/certs`), the
issuer, the audience, and the expiry. Keys are cached, refreshed every 5 minutes, and used for at
most an hour when they cannot be fetched, then every request is refused. Any failure is the same
`403`.

**Allow-lists (recommended).** Set `allowedEmails` and/or `allowedDomains` (exact domains, not
subdomains): then an Access policy that lets in more people than intended (say, everyone with a
Google account) still does not make them administrators. With any list set, service tokens are
admitted only when listed in `allowedServiceTokens` by client ID; without any list, everyone the
Access application lets through is an administrator, service tokens included. Authors are
recorded by e-mail address, or by client ID for service tokens.

**Cross-site requests are refused.** The admin API accepts changes only as
`Content-Type: application/json` requests from its own origin (browsers' `Sec-Fetch-Site` and
`Origin` headers are checked); clients outside a browser send neither header and are accepted.
The admin UI is not cached, not framed and not indexed, and its HTML carries a
Content-Security-Policy that allows its own scripts, styles and API only. Its scripts and styles
under `/assets/` are public files like the status page's: they are this project's open-source
code and hold no data.

A script signs in with a service token:

```sh
curl -H "CF-Access-Client-Id: <client ID>.access" -H "CF-Access-Client-Secret: <client secret>" \
  https://status.example.com/api/admin/me
```

## <a id="secrets"></a>秘密情報 / Secrets

### <a id="notification_keys-the-notification-encryption-key"></a>`NOTIFICATION_KEYS`: 通知の暗号鍵 / `NOTIFICATION_KEYS`: the notification encryption key

通知先の秘密のオプション（Slack と Discord の Webhook URL、Webhook の URL・署名用シークレット・ヘッダー）は、D1 に保存する前に、Worker のシークレット `NOTIFICATION_KEYS` の鍵を使って AES-256-GCM で暗号化します。管理 API はこれらを決して返しません。それぞれが設定済みかどうかだけを返し、編集でその項目を省けば、値はそのまま残ります。

**秘密情報は送信先に結び付けます.** 通知先のほかの秘密情報（Webhook の `signingSecret` と `headers`）は、その `url` のオリジンと一緒に暗号化し、通知先がそのオリジンに送る間だけ復号できます。通知先を別のオリジンに移す編集では、それらを入力し直すか、削除（`null`）しなければなりません。そうしなければ拒否されます（`400`、issue `secret_reentry_required`）。どんな編集をしても、保存済みの秘密情報を、管理者が選んだホストへハブに送らせることはできません。

- **形式:** `<id>:<key>`。ID は1〜32文字の英字、数字、`-`、`_` で、key は base64 で表した32バイトの乱数です。複数の鍵はカンマで区切ります。最初の鍵で暗号化し、残りの鍵は復号にだけ使います。
- **設定方法:** `echo "k1:$(openssl rand -base64 32)" | npx wrangler secret put NOTIFICATION_KEYS`、Deploy to Cloudflare ボタンの設定画面、またはダッシュボード（**Workers & Pages** → Worker → **Settings** → **Variables and Secrets**、[シークレット](https://developers.cloudflare.com/workers/configuration/secrets/)）で設定します。控えを、パスワードマネージャーなど安全な場所に残してください。
- **設定していない場合**（または形式が正しくない場合）、秘密情報を持つ通知先は保存できず（`503 encryption_key_missing`。何が問題かを示します）、それらへの送信は失敗して再試行されます。

**鍵の交換:**

1. 新しい鍵を先頭に置き、古い鍵をその後ろに残します:
   `echo "k2:$(openssl rand -base64 32),k1:<古い鍵>" | npx wrangler secret put NOTIFICATION_KEYS`。
   新しい値は `k2` で暗号化され、`k1` で暗号化した値も引き続き使えます。
2. `POST /api/admin/notifications/re-encrypt` で、すべての通知先の秘密情報を `k2` で暗号化し直します。復号できなかった通知先は一覧（`failed`）で返るので、それらの秘密情報を入力し直してください。
3. 古い鍵を外します: `echo "k2:<新しい鍵>" | npx wrangler secret put NOTIFICATION_KEYS`。

**送信先への結び付けがない版からアップグレードした後は**、`POST /api/admin/notifications/re-encrypt` を1回実行してください。以前に保存した秘密情報を、その通知先の送信先に結び付けます（通知先を保存しても同じことが起きます）。それまでは、結び付けのないまま動きます。

**鍵をすべてなくした場合**、保存済みの秘密情報は復号できません。新しい鍵を設定し、管理画面で各通知先の秘密情報を入力し直してください。それ以外には影響しません。

Notification targets' secret options (Slack and Discord webhook URLs; a webhook's URL, signing
secret and headers) are encrypted with AES-256-GCM before they are stored in D1, with a key from
the `NOTIFICATION_KEYS` Worker secret. The admin API never returns them: it says only whether
each one is set, and an edit that leaves one out keeps it.

**Secrets are bound to their destination.** A target's other secrets (a webhook's
`signingSecret` and `headers`) are encrypted together with the origin of its `url`, and decrypt
only while the target still sends there. An edit that moves the target to another origin must
enter them again, or remove them (`null`); otherwise it is refused (`400`, issue
`secret_reentry_required`). No edit can make the hub send a stored secret to a host an
administrator chose.

- **Format:** `<id>:<key>`, where the ID is 1-32 letters, digits, `-` or `_`, and the key is 32
  random bytes in base64. Several keys are separated by commas; the first encrypts, the others
  only decrypt.
- **Set it** with `echo "k1:$(openssl rand -base64 32)" | npx wrangler secret put NOTIFICATION_KEYS`,
  on the Deploy to Cloudflare button's setup page, or in the dashboard (**Workers & Pages** → the
  Worker → **Settings** → **Variables and Secrets**,
  [secrets](https://developers.cloudflare.com/workers/configuration/secrets/)). Keep a copy
  somewhere safe, such as a password manager.
- **Without it** (or with a malformed value), targets with secrets cannot be saved
  (`503 encryption_key_missing`, which says what is wrong) and deliveries to them fail and are
  retried.

**Rotating the key:**

1. Put a new key first and keep the old one after it:
   `echo "k2:$(openssl rand -base64 32),k1:<the old key>" | npx wrangler secret put NOTIFICATION_KEYS`.
   New values are encrypted with `k2`; values encrypted with `k1` still work.
2. `POST /api/admin/notifications/re-encrypt` encrypts every target's secrets with `k2`. It lists
   the targets it could not decrypt (`failed`): enter their secrets again.
3. Remove the old key: `echo "k2:<the new key>" | npx wrangler secret put NOTIFICATION_KEYS`.

**After upgrading from a version without destination binding,** run
`POST /api/admin/notifications/re-encrypt` once: it binds the secrets saved before to their
target's destination (saving a target does it too). Until then they still work, unbound.

**If every key is lost,** stored secrets cannot be decrypted: set a new key and enter each
target's secrets again in the admin UI. Nothing else is affected.

### <a id="secrets-of-monitors-secret"></a>監視の秘密情報: `secret()` / Secrets of monitors: `secret()`

認証情報が必要な監視のオプションでは、Worker のシークレットを名前で参照します。こうすると、値が `status.config.ts` に現れません（下の例を参照）。

名前は英字、数字、`_` で、数字では始まりません。ハブ自身のシークレット `NOTIFICATION_KEYS` は参照できません。値が監視先に送られてしまうため、`secret("NOTIFICATION_KEYS")` は設定の読み込み時にエラーになります。ランナーはチェックのたびにシークレットを読み、チェックが報告する内容からその値を取り除きます。シークレットを含むリクエストは https でだけ送り、リダイレクトはそのオリジンの中だけをたどります（[監視](#monitors)を参照）。シークレットが設定されていない（または空の）チェックは結果を出しません。そのことをログに記録し、監視は `unknown` になり、管理者に通知します。ローカル開発では、値を `.dev.vars` に書きます（[開発](#development)）。

A monitor option that needs a credential references a Worker secret by name, so that the value
never appears in `status.config.ts` (see the example below).

Names are letters, digits and `_`, not starting with a digit. The hub's own secret,
`NOTIFICATION_KEYS`, cannot be referenced: `secret("NOTIFICATION_KEYS")` is an error when the
configuration loads, since the value would be sent to the monitored endpoint. The runner reads
the secret at each check and removes its value from anything the check reports. A request that
carries a secret goes over https only, and follows redirects only within its origin (see
[Monitors](#monitors)). A check whose secret is not set (or is empty) produces no result: it is
logged, the monitor turns `unknown`, and administrators are notified. For local development, put
the values in `.dev.vars` ([Development](#development)).

```ts
import { secret } from "@naosystem/cf-workers-status-page-core";

http({ id: "api", url: "https://api.example.com/health", interval: "1m", headers: { Authorization: secret("API_TOKEN") } });
```

```sh
echo "Bearer <token>" | npx wrangler secret put API_TOKEN
```

## <a id="notifications"></a>通知 / Notifications

**通知の種類**（Slack、Discord、Webhook）は `status.config.ts`（`notifiers`）に登録します。**通知先**（Slack チャンネルの Webhook、どの監視か、どの出来事か）は管理画面で作り、秘密情報を暗号化して D1 に保存します（[秘密情報](#secrets)）。通知先の URL は、公開されたホストを指していなければなりません。IP アドレス、`localhost` のような1ラベルの名前、内部向けの名前（`.local`、`.internal`、`.lan`、`.home.arpa`、`.test` など）は、通知先の保存時、テスト時、送信時に拒否します。通知先は、すべての監視、または指定した監視とコンポーネントを対象にし、次の出来事を受け取ります:

| 出来事 | 既定 |
| --- | --- |
| `down`: `down` が確定した | 有効 |
| `recovered`: 監視が `down` から抜けた（`degraded` になった場合は、一部復旧と伝える） | 有効 |
| `degraded`、`degraded_recovered`: `degraded` が確定した、または `up` に戻った | 無効。通知先ごとに有効にできる |
| `unknown`: 結果が届かなくなった、または監視の Durable Object が応答しない | 管理者向けの通知先（`admin: true`）だけ |

新しい監視の最初の `down` は通知し、最初の `up` は通知しません。停止が続く間の再通知は（まだ）ありません。どの通知にも発生時刻が書かれています。送信は遅れたり、順番が入れ替わったりすることがあるためです。管理者向けの通知先では、`incidents.auto` のないページの `down` に、管理画面の障害告知フォームへのリンクが付きます（`baseUrl` を設定している場合）。通知は `locale` の言語で書かれます。

- **復旧は `down` を送った先に送ります.** 復旧の通知は、それが終わらせる `down`（または `degraded`）を送ったのと同じ通知先に、その通知先が今も復旧を受け取る設定であれば送ります。後から追加した通知先には送らず、`down` を受け取った通知先には、メンテナンス中でも復旧を送ります。停止中に `status.config.ts` から外れ、後で戻ってきた監視は、戻ったときに復旧を報告します。
- **メンテナンス.** 監視を表示するコンポーネントがメンテナンス中の間、その監視の通知は保留します。メンテナンスの終了時にまだ停止していれば、そのとき（1分以内）に `down` を通知します。その間に復旧していれば、どちらも通知しません。`unknown` はメンテナンス中でも通知します。監視そのものについての通知だからです。
- **`unknown`.** 1分ごとの Cron は、監視の結果が届かなくなったとき（ステータスページと同じ規則で、間隔2回分 + `timeout` + 1分の間、結果がない）、同じ時間だけ結果が状態を確定させないとき、または監視の Durable Object が応答しないときに、管理者向けの通知先に通知します。`unknown` が続く間に1回だけです。Durable Object のリクエストを節約するため、Cron は、監視が遅れうる時期になってからその監視を読みます（1分間隔の監視なら3〜4分ごと）。`notifications.unknownCheckInterval` で確認の頻度を下げられますが、その分この通知は遅れます。
- **送信.** 監視の Durable Object は、確定した変化の記録と、その出来事のキューへの投入を同じ手順で行います。キューが受け取れなければ、アラームで再試行します（30秒後から始め、間隔を最大10分まで広げます）。コンシューマーは通知先ごとに1つのメッセージを送るので、失敗する通知先がほかを止めることはありません。また、送る前に D1 で「通知 × 通知先」の記録を確認するので、重複したものを二度送ることはありません。送信に失敗すると、30秒、1、2、4、8、16分後、その後は30分ごと（またはサービスの `Retry-After` の後）に再試行し、全体で約8時間続けます。成功の見込みがないもの（Webhook が削除された、ペイロードが拒否された）は、すぐに失敗にします。
- **復旧**は、対応する `down`（または `degraded`）を送った通知先にだけ、メンテナンス中でも送ります。その `down` を送り終える前にキューが復旧を渡した場合、復旧はそれを待ちます（最大約5分）。
- **D1 を使えないとき**（たとえば Free プランの1日の上限に達したとき）、キューのコンシューマーは失敗にせず、間を置いて待ちます。送信は上のとおり再試行を続け、その後デッドレターキューに移ります。デッドレターキューのコンシューマーは D1 を待ち（試行の間隔は1分から倍々に延ばして最大1時間、最大100回）、その後それらを送信失敗として一覧に載せます。メッセージは、キューが保持する間だけ残ります。Paid プランでは既定で4日、Free プランでは24時間固定です（[Queues の料金](https://developers.cloudflare.com/queues/platform/pricing/)）。その時点でまだ届いていないものは失われます。
- **送信失敗**は、キューが諦めたものも含めて、管理画面（と `GET /api/admin/notifications/deliveries`）に一覧されます。送信の記録は30日間保存します。
- **キューの操作数**には、Free プランでは上限があります。[Free プランか Paid プランか](#free-plan-or-paid-plan)を参照してください。

**Discord:** フォーラムやメディアチャンネルの Webhook では、URL に `thread_id` を付けるのではなく、通知先の `threadId` を設定してください。

**Webhook のペイロード.** Webhook の種類は、JSON を POST します（https の URL にだけ送ります）。内容は `type: "cf-workers-status-page.notification"`、`version: 1`、`id`（再試行や重複でも同じ値。処理済みの ID は捨ててください）、`event`、`severity`、`title`、`text`、`occurredAt`（ISO 8601）、`monitor`（`{ id, name }`）、`state`、`previousState`、`links`、`locale` です。`signingSecret` を設定すると、各リクエストに `X-CF-Workers-Status-Page-Timestamp`（Unix 秒）と `X-CF-Workers-Status-Page-Signature: v1=<署名>` が付きます。署名は、`"<timestamp>.<raw body>"` の HMAC-SHA256 を16進数で表したものです。定数時間で比較して確かめ、古いタイムスタンプは拒否してください（`@naosystem/cf-workers-status-page-notifier-webhook` の `verifySignature` が両方を行います）。2xx で応答してください。408、429、5xx は再試行し、それ以外の応答とリダイレクトは失敗として扱います。`packages/notifier-webhook/src/index.ts` を参照してください。

**Kinds** (Slack, Discord, webhook) are registered in `status.config.ts` (`notifiers`).
**Targets** (a Slack channel's webhook, which monitors, which events) are created in the admin
UI and stored in D1, their secrets encrypted ([Secrets](#secrets)). A target's URL must name a
public host: IP addresses, single-label names such as `localhost`, and internal names (`.local`,
`.internal`, `.lan`, `.home.arpa`, `.test` and the like) are refused when the target is saved,
tested and sent to. A target covers every monitor, or the monitors and components it lists, and
receives:

| Event | Default |
| --- | --- |
| `down`: `down` was confirmed | on |
| `recovered`: the monitor left `down` (to `degraded`, it says it partially recovered) | on |
| `degraded`, `degraded_recovered`: `degraded` was confirmed, or went back to `up` | off; turn on per target |
| `unknown`: results stopped arriving, or the monitor's Durable Object does not answer | administrators' targets only (`admin: true`) |

A new monitor's first `down` is notified, its first `up` is not. There are no reminders while a
monitor stays down (yet). Every notification says when it happened: deliveries can arrive late
or out of order. For administrators' targets, a `down` on a page without `incidents.auto` links
to the admin UI's incident form, when `baseUrl` is set. Notifications use `locale`.

- **Recoveries go where the `down` went.** A recovery goes to exactly the targets that the `down`
  (or `degraded`) it ends went to, if they still take recoveries: a target added later does not
  get it, and a target that heard of the `down` gets its recovery even during maintenance. A
  monitor that left `status.config.ts` while down and comes back later reports its recovery then.
- **Maintenance.** While a component that shows a monitor is under maintenance, that monitor's
  notifications are held back. If it is still down when the maintenance ends, its `down` is
  notified then (within a minute); if it recovered meanwhile, neither is. `unknown` is notified
  even during maintenance: it is about monitoring itself.
- **`unknown`.** The every-minute Cron notifies administrators' targets when a monitor's results
  stop arriving (no result for two intervals plus `timeout` plus a minute, the status page's
  rule), when its results confirm no state for that long, or when its Durable Object does not
  answer. Once per stretch of `unknown`. To save Durable Object requests the Cron reads a monitor
  only once it could have become late (every 3 to 4 minutes for a 1-minute monitor);
  `notifications.unknownCheckInterval` makes it look less often, which delays these
  notifications.
- **Delivery.** The monitor's Durable Object records a confirmed change and queues its event in
  the same step; if the queue cannot take it, its alarm tries again (from 30 seconds, then up to
  10 minutes apart). The consumer sends one message per target, so a failing target does not
  hold up the others, and checks a record of each notification × target in D1 first, so a
  duplicate is never sent twice. A failed delivery is retried 30 s, 1, 2, 4, 8 and 16 minutes
  later, then every 30 minutes (or after the service's `Retry-After`), about 8 hours in all; one
  that cannot succeed (the webhook was deleted, the payload was refused) fails at once.
- **Recoveries** go to exactly the targets that were sent the matching `down` (or `degraded`),
  even during maintenance. If the queue hands over a recovery before that `down` has been sent
  out, the recovery waits for it (up to about 5 minutes).
- **When D1 is unavailable** (for example, at the Free plan's daily limit), the queue consumers
  back off instead of failing: deliveries keep retrying as above and then go to the dead letter
  queue, whose consumer waits for D1 (from a minute between attempts, doubling up to an hour, at
  most 100 attempts) and then lists them as failed. Messages are kept only as long as the queue
  keeps them: 4 days by default on the Paid plan, a fixed 24 hours on the Free plan
  ([Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)). Anything still
  undelivered then is lost.
- **Failed deliveries** are listed in the admin UI (and by
  `GET /api/admin/notifications/deliveries`), including what the queue gave up on. Delivery
  records are kept 30 days.
- **Queue operations** are limited on the Free plan; see
  [Free plan or Paid plan](#free-plan-or-paid-plan).

**Discord:** for a webhook of a forum or media channel, set the target's `threadId` rather than
adding `thread_id` to the URL.

**Webhook payload.** The webhook kind POSTs JSON (to an https URL only) with
`type: "cf-workers-status-page.notification"`, `version: 1`, `id` (the same for every retry
and duplicate: drop IDs you have handled), `event`, `severity`, `title`, `text`, `occurredAt`
(ISO 8601), `monitor` (`{ id, name }`), `state`, `previousState`, `links` and `locale`. With a
`signingSecret`, each request carries `X-CF-Workers-Status-Page-Timestamp` (Unix seconds) and
`X-CF-Workers-Status-Page-Signature: v1=<hex HMAC-SHA256 of "<timestamp>.<raw body>">`; check
it in constant time and reject old timestamps (`verifySignature` in
`@naosystem/cf-workers-status-page-notifier-webhook` does both). Answer 2xx; 408, 429 and 5xx
are retried, other answers and redirects are failures. See `packages/notifier-webhook/src/index.ts`.

## <a id="monitoring-and-the-status-page"></a>監視とステータスページ / Monitoring and the status page

### <a id="how-a-monitor-decides-its-state"></a>監視が状態を決める方法 / How a monitor decides its state

- **数える前に再確認します.** 失敗したチェックは `recheckInterval` の後に再確認します。`failureThreshold` 回続けて失敗すると `down`、`successThreshold` 回続けて成功すると `up` が確定します。状態の開始時刻は、確定した時刻ではなく、その連続した結果が始まった時刻です。
- **`unknown`** は表示するときに判断します。まだ確定した状態がない監視（新しい監視や、削除した後に戻した監視）か、最新の結果が遅れている監視です。遅れとは、間隔2回分 + `timeout` + 1分の間、結果がないことです（1分間隔の監視なら3分10秒）。結果が1回欠けるだけなら許容します。更新できないページが、古い「すべて正常」を現在の状態として表示し続けることはありません。
- **コンポーネントの状態**は、その監視の状態と、そのコンポーネントに影響する未解決の障害告知の影響度のうち、最も悪いものです: `down` > `degraded` > `unknown` > `up`。メンテナンスは状態の代わりではなく、状態と並べて表示します。
- **稼働率**は確定した状態だけを数えます。`down` は停止時間、`degraded` は稼働として数え、`unknown` の時間、メンテナンス、監視が外されていた時間は除きます。複数の監視を持つコンポーネントは、各時点でそれらのうち最も悪い状態を取ります。障害告知は対象の日に印として付くだけで、稼働率は変えません。監視のないコンポーネントには稼働率がありません。**網羅率**は、予定したチェックのうち結果が得られた割合です。
- **監視を削除しても履歴は残ります.** チェックは止まりますが、結果と状態は保存されたままで、設定に戻せば履歴を引き継いで再開します。削除した監視のデータは、管理者が管理画面で削除します（`DELETE /api/admin/monitors/:id`）。
- **保存期間.** 監視は、予定したチェック1回あたり最大1.5件の古い結果を削除します。そのため `retention` を短くすると、溜まった分は、それが占める期間のおよそ2倍の時間をかけて消えます（180日から30日にすると約300日）。保存期間より前の日にはデータがありません。

<!-- en -->

- **Re-checks before it counts.** A failed check is checked again after `recheckInterval`;
  `failureThreshold` failures in a row confirm `down` and `successThreshold` successes confirm
  `up`. A state starts when its run of results started, not when it was confirmed.
- **`unknown`** is worked out when shown: a monitor with no confirmed state yet (new, or back
  after it was removed), or whose latest result is late: none for two intervals plus its
  `timeout` plus a minute (3 minutes 10 seconds for a 1-minute monitor). One missed result is
  tolerated. A page that cannot be refreshed never keeps showing an old "all up" as current.
- **A component's state** is the worst of its monitors' states and of the impacts of unresolved
  incidents that affect it: `down` > `degraded` > `unknown` > `up`. Maintenance is shown next to
  the state, not instead of it.
- **Uptime** counts confirmed states only: `down` is downtime, `degraded` counts as up, and
  `unknown` time, maintenance and time when the monitor was removed are left out. A component with
  several monitors takes the worst of them at each moment. Incidents are markers on the days they
  cover and do not change uptime; components without monitors have none. **Coverage** is the
  share of scheduled checks that produced a result.
- **Removing a monitor keeps its history.** Its checks stop, but its results and states are kept;
  put it back and it resumes with its history. An administrator deletes the data of a removed
  monitor in the admin UI (`DELETE /api/admin/monitors/:id`).
- **Retention.** A monitor deletes at most 1.5 old results per scheduled check, so shortening
  `retention` clears the backlog in about twice the time it covers (from 180 to 30 days: about
  300 days). Days before the retention period have no data.

### <a id="the-status-page"></a>ステータスページ / The status page

| パス / Path | 表示するもの | Shows |
| --- | --- | --- |
| `/` | `status.config.ts` の最初のページ | The first page in `status.config.ts` |
| `/pages/:pageId` | 任意のページ（ページ同士はリンクしません） | Any page (pages do not link to each other) |
| `/pages/:pageId/incidents/:incidentId` | 障害告知と、その経過のすべて | An incident with its whole timeline |
| `/pages/:pageId/history` | 過去の障害告知と、監視で検知した停止（モダンテンプレートがリンクします） | Past incidents and the outages monitoring detected (linked from the modern template) |

ページには、タイトル、説明、ロゴ（アップロードした画像、または https の URL。以前に http の URL で保存したロゴは表示しません）、Web サイトへのリンク（いずれも管理画面で設定。ファビコンと色も設定できます: [アップロードした画像と色](#uploaded-images)）、全体の状態、未解決の障害告知とその最新の経過、実施中と予定のメンテナンス、各コンポーネントの状態と過去90日間のバー（スマートフォンでは30日）、過去の障害告知、監視で検知した停止を表示します。すべて[公開 API](#public-api) から取得し、ほかのサイトからは何も読み込みません（CDN は使いません。Web フォントはモダンテンプレートだけが使い、ページと一緒に配信します）。見た目は `pages[].template` で選びます（[テンプレート](#templates)）。以下は両方のテンプレートに共通です。

- **更新.** 状態は30秒ごと、履歴・停止・過去の障害告知は5分ごとに更新します。タブが非表示の間は何もしません。失敗すると、次の試行まで 30秒、1、2、4分 … と待ち（状態は最大5分）、ページに「今すぐ再試行」を表示します。
- **ページ内の移動.** 状態、履歴、障害告知の間は、再読み込みせずに移動します。ヘッダーとフッターはそのままで、移動先は自分の表示に要るもの（履歴なら過去の障害告知と停止）だけを読みます。ページの状態は状態と履歴の表示では30秒ごと、障害告知の表示では5分ごとに読みます。
- **古い状態.** 表示している状態が90秒より古くなると、全体のバナーが灰色になり、状態が最新でない可能性があることと、その経過時間を表示します。
- **バー**は、各日の確定した状態のうち最も悪いものを、色だけでなく形でも示します（モダンテンプレートでは、その日のうち停止・性能低下・メンテナンスだった時間の割合を、バーの下から色の高さで示します）。詳細（稼働率、網羅率、停止時間、障害告知、メンテナンス）は、ホバー、フォーカス、タップで表示し、矢印キーで日を移動できます。日の区切りは `timezone` の日です（凡例に書いてあります）。それ以外の時刻は、閲覧者のタイムゾーンで表示します。
- **言語.** ブラウザの言語設定で選びます（英語と日本語を同梱し、どちらにも当たらなければ英語）。フッターのメニューで切り替えられます。ライトとダークは、システムの設定に従います（モダンテンプレートでは、フッターで切り替えることもでき、その選択はブラウザに保存します）。
- **エラー.** ページが何かを表示できなかった場合は、状態が不明であることを表示し、自動で再試行します。
- **D1 を使えないとき**も、ページは監視による各コンポーネントの現在の状態を表示します。障害告知、メンテナンス、見た目は最後に読めた内容を使い、障害告知の情報が古い可能性があるという注意を表示します（API の `incidentsOutdated`。このような応答は最大10秒だけ保持します）。障害告知の個別ページは D1 が必要なので、D1 が戻るまで表示できません。
- **Content-Security-Policy.** ページとそのファイルは、`public/_headers` に書いた Content-Security-Policy などのヘッダー付きで配信します（[静的アセットのヘッダー](https://developers.cloudflare.com/workers/static-assets/headers/)）。許可するのは、自身のスクリプト、スタイル、API と、自身のサイトまたは任意の https URL の画像（ロゴのため）だけです。管理者が設定した色は、`style` 属性ではなく CSSOM で `<html>` に CSS 変数として設定するので、インラインのスタイルを許可する必要はありません。ほかのサイトからフォントなどを読み込むには、`public/_headers` を編集してください。これらのヘッダーはビルド（`npm run preview` やデプロイ）に適用され、`npm run dev` では適用されません。

A page shows its title, description, logo (an uploaded image or an https URL; a logo saved
earlier with an http URL is not shown) and website link (set in the admin UI, as are its
favicon and colours: [Uploaded images and colours](#uploaded-images)), the overall
state, unresolved incidents with their latest updates, maintenance in progress and scheduled,
each component with its state and its last 90 days as bars (30 on phones), past incidents and
the outages monitoring detected. Everything comes from the [public API](#public-api); nothing is
loaded from other sites (no CDNs; only the modern template uses web fonts, served with the page).
`pages[].template` chooses how it looks ([Templates](#templates)); what follows holds for both.

- **Refreshing.** The status every 30 seconds; the history, outages and past incidents every 5
  minutes. Nothing while the tab is hidden. After a failure, the next attempt waits 30 s, 1, 2,
  4 minutes … (at most 5 minutes for the status) and the page offers "retry now".
- **Moving within a page.** Its status, history and incidents open without reloading: the
  header and footer stay, and the view opened reads only what it shows (the history: past
  incidents and outages). The page's status is read every 30 seconds with its status or
  history shown, every 5 minutes with an incident shown.
- **Out-of-date status.** Once the status shown is more than 90 seconds old, the overall banner
  turns grey and says that the status may be out of date, with its age.
- **Bars** show each day's worst confirmed state by shape as well as colour (in the modern
  template, the share of the day spent down, degraded and in maintenance, by height from the
  bottom); details (uptime,
  coverage, downtime, incidents, maintenance) show on hover, focus or tap, and the arrow keys
  move between days. Days are days of `timezone` (the legend says which); other times are shown
  in the visitor's time zone.
- **Languages.** The browser's languages choose (English and Japanese are included, English is
  the fallback); the footer's menu overrides it. Light and dark follow the system (the modern
  template's footer can also switch them; the choice is kept in the browser).
- **Errors.** If the page fails to show something, it says that the status is unknown and tries
  again by itself.
- **When D1 is unavailable**, the page still shows every component's current state from
  monitoring, with the incidents, maintenance and appearance it last read, and a notice that the
  incident information may be out of date (`incidentsOutdated` in the API; such responses are
  kept at most 10 seconds). The incident pages themselves need D1 and fail until it is back.
- **Content-Security-Policy.** The page and its files are served with a Content-Security-Policy
  and other headers from `public/_headers`
  ([static asset headers](https://developers.cloudflare.com/workers/static-assets/headers/)): its
  own scripts, styles and API only, and images from its own site or any https URL (for the logo).
  Administrators' colours are set as CSS variables on `<html>` through the CSSOM, not a `style`
  attribute, so no inline styles need allowing. To load fonts or other resources from other
  sites, edit `public/_headers`. These headers apply
  to a build (`npm run preview`, deploys), not under `npm run dev`.

### <a id="uploaded-images"></a>アップロードした画像と色 / Uploaded images and colours

管理画面の「ページの見た目」では、ページごとに次のものも設定できます。

- **ロゴ画像とファビコン.** PNG、JPEG、GIF、WebP、ICO で、512 KB まで。ロゴ画像はタイトルの代わりに表示し、ロゴの URL より優先します。ファビコンはブラウザのタブとブックマークに表示します。SVG は受け付けません（スクリプトを含められ、画像はステータスページと同じオリジンから配信するため）。形式はファイルの先頭のバイトで確かめます。
- **色.** 背景色、ヘッダーの色（modern テンプレートの上部の帯）、アクセント色（リンクとフォーカス枠）を、ライトとダークで別々に設定します（`#rrggbb`）。設定しない色はテンプレートの色のままです。ヘッダーの文字は、ヘッダーの色に合わせて白か黒の読みやすい方に自動で切り替わります。管理画面は両方のモードのプレビューを表示し、文字やリンクのコントラスト比が 4.5:1 を下回るときは警告します（保存は止めません）。

**画像の保存.** 画像は R2 バケット（`UPLOADS` バインディング）に、ページごとに、ランダムな ID を名前にして保存します。ID はアップロードのたびに新しく作り（同じファイルでも別の ID）、使い回しません。管理画面はファイルを選んだ時点でアップロードし、フォームの保存で見た目に結び付けます。画像の URL（`/api/pages/:pageId/images/:id`）は中身が変わらないので、ブラウザは1年間キャッシュし（`immutable`）、配信で D1 を読むことはありません。見た目から外れた画像は、アップロードから1日たった後、そのページの見た目を次に保存したときに削除します。

**R2 がない場合.** `UPLOADS` バインディングは任意です。R2 を有効にできないアカウントでは `wrangler.jsonc` の `r2_buckets` を削除してください。画像のアップロードはできなくなり、管理画面はそう表示します。それ以外（ロゴの URL、色を含む）はそのまま動きます。バインディングを外す前に保存した画像は表示せず、ロゴの URL かタイトルを表示します。保存済みの画像は付けたまま、ほかの項目を保存できます。R2 の無料枠は、ストレージ 10 GB-月、Class A 操作（書き込み・一覧）100万回/月、Class B 操作（読み取り）1,000万回/月です（[R2 の料金](https://developers.cloudflare.com/r2/pricing/)）。この用途ではほとんど使いません。

<!-- en -->

The admin UI's Appearance view also sets, per page:

- **A logo image and a favicon.** PNG, JPEG, GIF, WebP or ICO, up to 512 KB. The logo image
  shows instead of the title, before the logo URL; the favicon shows in browser tabs and
  bookmarks. SVG is not accepted (it can carry scripts, and images are served from the status
  page's own origin). The format is checked by the file's first bytes.
- **Colours.** Background, header (the modern template's top bar) and accent (links and focus
  outlines), for light and dark separately (`#rrggbb`); colours not set stay the template's. The
  header's text turns white or black, whichever reads better on its colour. The admin UI
  previews both modes and warns when text or links would fall below a contrast of 4.5:1 (it
  does not prevent saving).

**Where images go.** Images are stored in the R2 bucket (the `UPLOADS` binding), per page, under
a random ID, new for every upload (the same file uploaded again gets another) and never reused.
The admin UI uploads a file as soon as it is chosen, and the
form's save names it in the appearance. An image's URL (`/api/pages/:pageId/images/:id`) never
changes what it serves, so browsers keep it for a year (`immutable`), and serving it reads
nothing from D1. Images the appearance no longer names are deleted once they are a day old,
the next time the page's appearance is saved.

**Without R2.** The `UPLOADS` binding is optional: on an account where R2 cannot be enabled,
remove `r2_buckets` from `wrangler.jsonc`. Uploads are then unavailable, which the admin UI
says; everything else, logo URLs and colours included, works as before. Images saved before the
binding was removed are not shown: the logo URL or the title shows instead, and the other
fields can still be saved with them. R2's free tier is
10 GB-month of storage, 1 million Class A operations (writes, lists) and 10 million Class B
operations (reads) a month ([R2 pricing](https://developers.cloudflare.com/r2/pricing/)), of
which this uses very little.

## <a id="free-plan-or-paid-plan"></a>Free プランか Paid プランか / Free plan or Paid plan

Workers Free プランでも、1日の上限の範囲ですべての機能が動きます。上限はアカウント全体にかかり、UTC 0時にリセットされます。Durable Object の上限を超えると、リセットまでの間、アカウント内のすべての Durable Object で、**監視を含めて**その種類の操作が失敗します（[Durable Objects の料金](https://developers.cloudflare.com/durable-objects/platform/pricing/)）。

| Free プラン（1日あたり） | 上限 | このプロジェクトで使うもの |
| --- | --- | --- |
| Durable Object のリクエスト（アラームを含む） | 100,000 | チェック、Cron、開いているステータスページ: **最初に当たる上限** |
| Durable Object の書き込み行数 | 100,000 | チェック結果とアラーム |
| Durable Object の読み取り行数 | 500万 | チェック、開いているステータスページ |
| Durable Object の実行時間 | 13,000 GB-s | チェックが監視のオブジェクトを動かし続ける時間 |
| Worker のリクエスト | 100,000（[制限](https://developers.cloudflare.com/workers/platform/limits/#daily-requests)） | 閲覧者の API 呼び出し、Cron、キューのコンシューマー、アップロードした画像（閲覧者ごとに初回だけ。ブラウザが1年キャッシュする）。静的アセットは無料 |
| Queue の操作 | 10,000（[Queues の料金](https://developers.cloudflare.com/queues/platform/pricing/)） | 通知 |
| D1 の読み取り / 書き込み行数 | 500万 / 100,000 | 障害告知、通知先、送信の記録: わずか |

**1分ごとにチェックする監視1つ**の、1日あたりのコストは次のとおりです（5分ごとなら5分の1）。書き込みと読み取りの行数は、チェック1回あたりと開いているページの分を計測した値です:

| | Durable Object のリクエスト | 書き込み行数 | 読み取り行数 |
| --- | --- | --- | --- |
| チェック（1回につきアラーム1回） | 1,440。失敗中は再確認1回ごとに1回増える | チェック1回につき2行（結果と次のアラーム。状態が確定すると4行）: 2,880。`retention` を設定すると1回につき3行（4,320）、短くした保存期間に追いつくまでは最大3.5行（5,040） | チェック1回につき約19行、失敗中は最大48行 |
| Reconciler の10分ごとの確認 | 144 | なし | 1回につき約14行 |
| Cron の `unknown` の確認 | 288〜432（`unknownCheckInterval` を長くすると減る） | なし | 1回につき約5行 |
| その監視を表示するページを誰かが開いている間 | 1,440〜2,880（計測値: 約2,100） | 24 | 約32,000 |

1日あたりの固定費: Cron で Durable Object のリクエスト1,440回と Worker のリクエスト1,440回。さらに、開いているステータスページを受け持つ Worker isolate 1つにつき、Durable Object のリクエスト約3,500回（30秒ごとの状態、5分ごとの履歴と停止）と Worker のリクエスト約3,700回（`"workers-cache"` では Worker のリクエストが2倍になり、Durable Object のリクエストはキャッシュミスのときだけ）。

**Free プランでの推奨: 1分ごとにチェックする監視を約15件まで.** 誰も見ていなければ、15件で Durable Object のリクエストは1日約32,000回です。ページを1日中開いていると約67,000〜78,000回になり、閲覧者がもう少し増えたり、チェックが失敗したりする分の余裕が残ります。書き込みは1日43,200行です（`retention` を設定すると64,800行、短くした保存期間に追いつくまでは75,600行）。監視が約20件を超えると、開いているページ1つで Durable Object のリクエストを使い切ることがあります。Cloudflare ダッシュボードで使用量を確認し、監視を増やしたい場合や、数人より多くの人が開いたままにするページがある場合は、Paid プランに移ってください。

- **実行時間.** Durable Object は動いている間 128 MB として課金され、チェックは対象が応答するまで監視のオブジェクトを動かし続けます。チェックにかかる1秒あたり、約 0.125 GB-s です。速いチェックなら上限よりはるかに少なく済みますが、対象がすべて10秒の `timeout` まで応答しない監視が15件あると、1日約27,000 GB-s になります。Free プランでは `timeout` を短くしてください。
- **通知.** メッセージを1つ届けるのに Queue の操作が3回（書き込み、読み取り、削除）かかり、再試行1回ごとに1回増えます。出来事1件で1メッセージ、それに加えて通知先ごとに1メッセージです。3つの通知先に通知する変化1件で約12回なので、1日10,000回なら数百件の変化を通知できます。通知先が失敗し続けている間は、通知できる数が減ります（8時間再試行した送信1件で約23回）。Free プランはキューのメッセージを24時間保持し、再試行にかかる時間より長く持ちます。
- **Worker のリクエスト.** 開いているステータスページ1つで1日約3,700回かかるので、約25人が1日中開いていると100,000回に達します。公開 API をループで呼び出す人がいても同じことが起きます。Cron とキューのコンシューマーも Worker の呼び出しです。1日の上限でこれらが止まるかどうかを Cloudflare は文書化していないので、上限から十分に余裕を取ってください。

**Paid プラン**（月5ドル）では、月あたりの無料枠に、Worker のリクエスト1,000万回、Durable Object のリクエスト100万回（超過分は100万回あたり0.15ドル）、実行時間 400,000 GB-s（超過分は100万 GB-s あたり12.50ドル）、書き込み5,000万行と読み取り250億行、Queue の操作100万回が含まれます（[Workers の料金](https://developers.cloudflare.com/workers/platform/pricing/)）。たとえば、1分ごとにチェックする監視100件で、Durable Object のリクエストは月約600万回（無料枠を超えた分は1ドル未満）、書き込みは860万行（`retention` ありで1,300万行）です。実行時間は、チェックの平均所要時間1秒あたり月約540,000 GB-s なので、平均約0.7秒未満のチェックなら無料枠に収まります。チェックの所要時間は対象によって違い、ここでは計測していません。

Everything works on the Workers Free plan, within its daily limits. They apply to the whole
account and reset at 00:00 UTC; past a Durable Object limit, operations of that kind fail for
every Durable Object in the account, **monitors included**, until then
([Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).

| Free plan, per day | Limit | What uses it here |
| --- | --- | --- |
| Durable Object requests (including alarms) | 100,000 | Checks, the Cron, open status pages: **the limit that binds first** |
| Durable Object rows written | 100,000 | Check results and alarms |
| Durable Object rows read | 5 million | Checks, open status pages |
| Durable Object duration | 13,000 GB-s | The time checks keep their monitor's object busy |
| Worker requests | 100,000 ([limits](https://developers.cloudflare.com/workers/platform/limits/#daily-requests)) | Visitors' API calls, the Cron, the queue consumer; static assets are free |
| Queue operations | 10,000 ([Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)) | Notifications |
| D1 rows read / written | 5 million / 100,000 | Incidents, targets, delivery records: little |

What a **monitor checked every minute** costs a day (a monitor checked every 5 minutes costs a
fifth). The rows written and read, per check and for an open page, are measured:

| | Durable Object requests | Rows written | Rows read |
| --- | --- | --- | --- |
| Checks (an alarm each) | 1,440, plus one per re-check while failing | 2 per check (the result and the next alarm; 4 when a state is confirmed): 2,880. With `retention`, 3 per check (4,320), up to 3.5 while a shortened retention catches up (5,040) | about 19 per check, up to 48 while failing |
| The Reconciler's check-up every 10 minutes | 144 | none | about 14 each |
| The Cron's `unknown` check | 288 to 432 (fewer with a longer `unknownCheckInterval`) | none | about 5 each |
| While anyone has a page open that shows it | 1,440 to 2,880 (measured: about 2,100) | 24 | about 32,000 |

Fixed costs a day: the Cron, 1,440 Durable Object requests and 1,440 Worker requests; and for
each Worker isolate serving an open status page, about 3,500 Durable Object requests (the status
every 30 seconds, history and stoppages every 5 minutes) and about 3,700 Worker requests (with
`"workers-cache"`: twice the Worker requests, and Durable Object requests only on cache misses).

**Recommendation for the Free plan: up to about 15 monitors checked every minute.** With nobody
watching, 15 take about 32,000 Durable Object requests a day; with a page open all day, about
67,000 to 78,000, which leaves room for a few more viewers and for failing checks. They write
43,200 rows a day (64,800 with `retention`, 75,600 while a shortened retention catches up). Past
about 20 monitors, one open page can exhaust the Durable Object requests. Watch your usage in the
Cloudflare dashboard, and move to the Paid plan for more monitors, or for a page that more than a
few people keep open.

- **Duration.** A Durable Object is billed as 128 MB for as long as it is active, and a check
  keeps its monitor's object active until the target answers: about 0.125 GB-s per second a
  check takes. Quick checks are far below the limit, but 15 monitors whose targets all hang
  until a 10-second `timeout` would take about 27,000 GB-s a day; on the Free plan, keep
  `timeout` short.
- **Notifications.** Delivering a message takes 3 Queue operations (write, read, delete), and each
  retry one more. An event is one message, plus one per target: a change notified to 3 targets
  takes about 12, so 10,000 a day is room for several hundred notified changes, fewer while a
  target keeps failing (about 23 operations for a delivery retried for 8 hours). The Free plan
  keeps queued messages for 24 hours, longer than the retries take.
- **Worker requests.** An open status page costs about 3,700 a day, so about 25 viewers keeping
  it open all day reach the 100,000, and so can anyone calling the public API in a loop. The Cron
  and the queue consumer are Worker invocations too; Cloudflare does not document whether the
  daily limit stops them, so stay well below it.

**On the Paid plan** ($5 a month), the monthly allowances include 10 million Worker requests,
1 million Durable Object requests (then $0.15 per million), 400,000 GB-s of duration (then $12.50
per million GB-s), 50 million rows written and 25 billion rows read, and 1 million Queue
operations ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)). For
example, 100 monitors checked every minute make about 6 million Durable Object requests a month
(under $1 beyond the allowance) and write 8.6 million rows (13 million with `retention`); their
duration is about 540,000 GB-s a month per second an average check takes, so checks that average
under about 0.7 s stay within the allowance. Check durations depend on your targets and are not
measured here.

## <a id="known-risks"></a>既知のリスク / Known risks

- **Cloudflare 自体の障害.** 監視、ステータスページ、通知はすべて Cloudflare 上で動くので、Cloudflare で障害が起きると（または Free プランの上限を使い切ると）、すべてが同時に止まります。Cloudflare の外から、次の両方の方法でハブを監視してください:
  - *外から:* 外部の死活監視サービスで `https://<あなたのホスト>/api/health` を監視します。これは Worker だけで `GET`（`HEAD` は不可）に `200 {"ok":true}` を返します（Worker のリクエスト1回、Durable Object なし）。または `/api/status` を監視します。こちらはページの Durable Object も必要とし、Durable Object が応答できなければ `5xx` で失敗します（Durable Object のリクエストも消費します）。
  - *ハブからのハートビート:* 多くの監視サービスは、呼ばれなくなると警告する「ハートビート」や「デッドマンスイッチ」の URL を提供しています。それを、どのコンポーネントにも入れない監視として追加します（非公開のままにするため）。たとえば `http({ id: "heartbeat", url: "https://<ハートビートの URL>", interval: "5m" })` です。何らかの理由で監視が止まると呼び出しも止まり、外部のサービスが警告します。リポジトリが公開されている場合は URL も公開されるので、トークンをヘッダーで受け取るサービスを選び、`secret()` で渡すことをお勧めします。
- **Free プランの上限**を超えると、その日の残り（UTC 0時まで）監視が止まります。[Free プランか Paid プランか](#free-plan-or-paid-plan)を参照してください。
- **匿名のトラフィック.** 公開 API は誰でも読めます。Free プランでは、アクセスの多いページや公開 API を呼び出すスクリプトが、アカウントの1日100,000回の Worker リクエストを使い切ることがあります。また既定の `"durable-object"` キャッシュでは、Durable Object のリクエストは閲覧者を受け持つ Worker isolate の数に比例して増える（各 isolate は応答を30秒しか保持しない）ので、多くの場所から来るトラフィックほど、ページの Durable Object に頻繁に届きます。アクセスが集まりうる公開ページには Paid プランを使ってください（閲覧者を Durable Object から遠ざけるには `"workers-cache"` も）。
- **`NOTIFICATION_KEYS` をなくす**と、すべての通知先の秘密情報を入力し直すことになります（[秘密情報](#secrets)）。
- **パージの制限.** `"workers-cache"` では、パージはアカウントあたり1分に5回（バースト25回）に制限されます。障害告知の更新が一度に多く来ると、パージが拒否された分、古い応答が最大30秒残ります。
- **地点は固定です.** 監視の Durable Object は作られた場所にとどまります。監視を移すには、新しい `id` と新しい履歴が必要です（[地点](#location)）。
- **短くした保存期間は取り消せません.** 削除した結果は復元できません。

<!-- en -->

- **Cloudflare itself fails.** Monitoring, the status page and notifications all run on
  Cloudflare, so an outage there (or an exhausted Free-plan limit) silences all of them at once.
  Watch the hub from outside Cloudflare, both ways:
  - *From outside:* point an external uptime service at `https://<your host>/api/health`, which
    answers a `GET` (not `HEAD`) with `200 {"ok":true}` from the Worker alone (one Worker
    request, no Durable Object), or at `/api/status`, which also needs the page's Durable Object
    and fails with a `5xx` when it cannot answer (it also costs Durable Object requests).
  - *A heartbeat from the hub:* many monitoring services offer a "heartbeat" or "dead man's
    switch" URL that alerts when it stops being called. Add it as a monitor, in no component (so
    that it stays private), for example
    `http({ id: "heartbeat", url: "https://<heartbeat URL>", interval: "5m" })`. If monitoring
    stops for any reason, the calls stop and the outside service alerts you. If your repository is
    public, the URL is public too: prefer a service that takes a token in a header, which you can
    pass with `secret()`.
- **Free-plan limits** stop monitoring for the rest of the day (until 00:00 UTC) when exceeded;
  see [Free plan or Paid plan](#free-plan-or-paid-plan).
- **Anonymous traffic.** Anyone can read the public API. On the Free plan, a busy page or a script
  calling it can use up the account's 100,000 Worker requests a day; and with the default
  `"durable-object"` cache, Durable Object requests grow with the number of Worker isolates
  serving visitors (each keeps a response for 30 seconds only), so traffic from many places reaches
  the page's Durable Object more often. For a public page that may draw traffic, use the Paid plan
  (and `"workers-cache"` to keep visitors away from the Durable Objects).
- **Losing `NOTIFICATION_KEYS`** means entering every target's secrets again
  ([Secrets](#secrets)).
- **Purge limits.** With `"workers-cache"`, purges are limited to 5 a minute per account (bursts
  of 25); when many incident updates come at once, a refused purge leaves the old response up to
  30 seconds.
- **Location is fixed.** A monitor's Durable Object stays where it was created; moving a monitor
  means a new `id` and a new history ([Location](#location)).
- **Shortened retention is final.** Deleted results cannot be recovered.

## <a id="development"></a>開発 / Development

```sh
npm ci
npm run dev
```

Vite が表示する URL（既定は `http://localhost:5173/`）を開きます。ステータスページは `/`、管理画面は `/admin` にあり、`/api/health` は `{"ok":true}` を返します。Worker、Durable Objects、D1、キューはローカルの `workerd` で動き、データは `.wrangler/state` に置かれます（git では無視されます。削除すると最初からになります）。監視は最初の API リクエストで始まり、あなたのマシンからチェックします。ローカル開発では Cron は自動で動かないので、`curl http://localhost:5173/cdn-cgi/local/scheduled` で1回実行してください（[Cron Triggers をローカルで試す](https://developers.cloudflare.com/workers/configuration/cron-triggers/#test-cron-triggers-locally)）。

**ローカルでのログイン.** `npm run dev` の前には Cloudflare Access がありません。`.env.development.local`（git では無視されます）に下の1行を書き、`npm run dev` を再起動してください。すると、`localhost`、`127.0.0.1`、`[::1]` へのリクエストは、`auth` がなくても `local-dev` としてログインした状態になります。この迂回は、Vite の開発サーバーにだけ組み込まれます。どのビルド（`npm run deploy` と Deploy to Cloudflare ボタンが実行する `vite build`）でも、変数、モード、`NODE_ENV` にかかわらず取り除かれます。リクエストのヘッダーで有効にすることはできません。開発サーバーをネットワークに公開する `vite --host` とは組み合わせないでください。ネットワーク上のクライアントが `Host: localhost` を送れてしまいます。

Open the URL Vite prints (`http://localhost:5173/` by default): the status page is at `/`, the
admin UI at `/admin`, and `/api/health` answers `{"ok":true}`. The Worker, its Durable Objects,
D1 and the queues run locally in `workerd`, with their data in `.wrangler/state` (ignored by git;
delete it to start over). Monitors start with the first API request and check from your machine.
Local development does not run the Cron by itself; run it once with
`curl http://localhost:5173/cdn-cgi/local/scheduled`
([testing Cron Triggers locally](https://developers.cloudflare.com/workers/configuration/cron-triggers/#test-cron-triggers-locally)).

**Signing in locally.** `npm run dev` has no Cloudflare Access in front of it. Create
`.env.development.local` (ignored by git) with the line below and restart `npm run dev`:
requests to `localhost`, `127.0.0.1` and `[::1]` are then signed in as `local-dev`, even without
`auth`. The bypass is compiled in only by Vite's dev server: every build (`vite build`, which
`npm run deploy` and the Deploy to Cloudflare button run) compiles it out, whatever the
variables, mode or `NODE_ENV`. It cannot be switched on by a request header. Do not combine it with `vite --host`, which exposes
the dev server to your network, where a client can send `Host: localhost`.

```sh
ADMIN_DEV_BYPASS=1
```

**ローカルのシークレット**は `.dev.vars`（git では無視されます）に書きます。たとえば `NOTIFICATION_KEYS=k1:<openssl rand -base64 32 の出力>` や、監視が参照するシークレットです。`wrangler types`（`npm run cf-typegen`）は `.dev.vars` の名前を `worker-configuration.d.ts` に加えてしまいます。型を作り直す間は、`.dev.vars` を別の場所に移してください。

| コマンド | 内容 |
| --- | --- |
| `npm run dev` | Worker を `workerd` で動かす Vite の開発サーバー |
| `npm run typecheck` | すべてを型チェック（`tsc -b`） |
| `npm run lint` | [oxlint](https://oxc.rs/docs/guide/usage/linter)。下で述べるパッケージの規則を含む |
| `npm run build` | 型チェックの後、Worker と SPA を `dist/` にビルド |
| `npm run preview` | ビルドの後、本番ビルドをローカルで配信 |
| `npm run deploy` | ビルドの後、あなたの Cloudflare アカウントにデプロイ |
| `npm run cf-typegen` | `wrangler.jsonc` を編集した後に、`worker-configuration.d.ts` を作り直す |

Durable Object のクラスは、旧来の `migrations` 配列ではなく、`wrangler.jsonc` の [`exports`](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/) で宣言しています。一度 `exports` でデプロイした Worker は、`migrations` に戻せません。D1 のマイグレーションは追加だけで、Worker が適用します（`worker/db/schema.ts`）。そのため、ロールバックしても古い版は動き続けます。

**Local secrets** go in `.dev.vars` (ignored by git), such as
`NOTIFICATION_KEYS=k1:<output of openssl rand -base64 32>` and the secrets your monitors
reference. `wrangler types` (`npm run cf-typegen`) adds the names in `.dev.vars` to
`worker-configuration.d.ts`: move `.dev.vars` aside while you regenerate the types.

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server with the Worker in `workerd` |
| `npm run typecheck` | Type-check everything (`tsc -b`) |
| `npm run lint` | [oxlint](https://oxc.rs/docs/guide/usage/linter), including the package rules below |
| `npm run build` | Type-check, then build the Worker and the SPA into `dist/` |
| `npm run preview` | Build, then serve the production build locally |
| `npm run deploy` | Build, then deploy to your Cloudflare account |
| `npm run cf-typegen` | Regenerate `worker-configuration.d.ts` after editing `wrangler.jsonc` |

Durable Object classes are declared with
[`exports`](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
in `wrangler.jsonc` rather than the legacy `migrations` array; once deployed with `exports`, a
Worker cannot go back to `migrations`. D1 migrations are additive and applied by the Worker
(`worker/db/schema.ts`), so an older version keeps working after a rollback.

## <a id="extending"></a>拡張 / Extending

### <a id="adding-a-language"></a>言語の追加 / Adding a language

言語タグ（`fr.ts` や `pt-BR.ts` など）を名前にしたファイルを2つ追加します。`shared/i18n/locales/en.ts`（通知とステータスページ）のコピーと、`shared/i18n/admin/en.ts`（管理画面。閲覧者がダウンロードしないように分けています）のコピーで、日本語のファイルと同じように型を付けます（`satisfies Translation`、`satisfies AdminTranslation`）。翻訳してデプロイすれば、ほかに変えるものはありません。ファイルはアプリのビルド時に見つけられます。省いたメッセージは英語で表示されますが、`shared/i18n` の各言語には、すべてのメッセージを `{placeholders}` 付きでそろえてください。ブラウザがダウンロードするのは、英語と表示する言語だけです。通知の種類は自分のフォームの文言を持っているので、それらの `messages`（`packages/notifier-*/src/messages.ts`）にも言語を追加してください。通知にその言語を使うには、`locale` を設定します。

Add two files named by a language tag (such as `fr.ts` or `pt-BR.ts`): a copy of
`shared/i18n/locales/en.ts` (notifications and the status page) and a copy of
`shared/i18n/admin/en.ts` (the admin UI, kept apart so that visitors never download it), typed
like the Japanese files (`satisfies Translation`, `satisfies AdminTranslation`). Translate them
and deploy: nothing else changes, the files are found when the app is built. Messages left out
show in English, but give each language under `shared/i18n` every message, with its
`{placeholders}`. Browsers download English and the language they show only.
Notifier kinds bring the texts of their own form: add the language to their `messages`
(`packages/notifier-*/src/messages.ts`). Set `locale` to use the language for notifications.

### <a id="adding-a-notifier-kind-or-a-check-provider"></a>通知の種類やチェックのプロバイダーの追加 / Adding a notifier kind or a check provider

通知の種類とチェックのプロバイダーは、`packages/notifier-slack` や `packages/provider-http` と同じく、`packages/` の下のパッケージです:

1. `packages/<name>/` を作り、`@naosystem/cf-workers-status-page-<name>` という名前の `package.json`（`"exports": { ".": "./src/index.ts" }`、依存に `@naosystem/cf-workers-status-page-core`、peer 依存に `zod`）、隣のパッケージからコピーした `tsconfig.json`、`src/index.ts` を置きます。
2. ルートの `package.json` の `dependencies` と、ルートの `tsconfig.json` の `references` にパッケージを追加し、`npm install` を実行します。
3. `status.config.ts` に登録します: `notifiers: [myKind()]` または `monitors: [myCheck({ … })]`。

規約は、各パッケージの `tsconfig.json`（`rootDir`、ランタイムの型なし）と `.oxlintrc.json` で強制しています:

- パッケージは標準の Web API だけを使います。Worker の内部、`cloudflare:` からの import、宣言した依存以外のパッケージ外からの import は使いません。
- **グローバルの `fetch` ではなく、必ず `ctx.fetch` を使います.** ハブの fetch がタイムアウトと User-Agent を適用します。`ctx.signal` も渡してください。
- **オプションは Zod のオブジェクトスキーマ**（`z.strictObject`）にします。管理画面はそこから通知の種類のフォームを作ります（タイトルと説明は `.meta()` と `messages` から取ります）。

**通知の種類**は、`@naosystem/cf-workers-status-page-core` の `defineNotifier({ type, name, options, secretOptions, messages, send })` です。`secretOptions` は、暗号化して二度と表示しないオプションの一覧です。`send(notification, options, ctx)` は、すでに `locale` で書かれた通知を整形して送ります。失敗したら、再試行で解決しうるかどうかを示す `NotifierError` を投げます（HTTP の応答には `expectSuccess(response, "Service")` がそれを行います）。メッセージに秘密情報を入れてはいけません。

**チェックのプロバイダー**は `defineProvider({ type, options, requires: ["fetch"], check })` で、`status.config.ts` で使うファクトリーを返します。オプションには、監視の設定のキー（`id`、`interval` など）を使えません。値が秘密になりうるところでは、`secretOr(z.string())` で `secret()` の参照を受け付けます。`check(options, ctx)` は実際の値を受け取ります。戻り値は `{ state: "up" | "degraded" | "down", latencyMs?, message?, details? }` です。タイムアウトのときは例外を投げるだけでよく、チェックは `down` として記録されます。

Notifier kinds and check providers are packages under `packages/`, like
`packages/notifier-slack` and `packages/provider-http`:

1. Create `packages/<name>/` with a `package.json` named
   `@naosystem/cf-workers-status-page-<name>` (`"exports": { ".": "./src/index.ts" }`,
   `@naosystem/cf-workers-status-page-core` as a dependency, `zod` as a peer dependency), a
   `tsconfig.json` copied from a sibling package, and `src/index.ts`.
2. Add the package to `dependencies` in the root `package.json` and to `references` in the root
   `tsconfig.json`, then run `npm install`.
3. Register it in `status.config.ts`: `notifiers: [myKind()]`, or `monitors: [myCheck({ … })]`.

Conventions, enforced by each package's `tsconfig.json` (`rootDir`, no runtime types) and by
`.oxlintrc.json`:

- Packages use standard web APIs only: no Worker internals, no `cloudflare:` imports, no imports
  from outside the package except declared dependencies.
- **Use `ctx.fetch`, never the global `fetch`.** The hub's fetch applies the timeout and the
  User-Agent. Pass `ctx.signal` along.
- **Options are a Zod object schema** (`z.strictObject`). The admin UI builds a notifier's form
  from it (titles and descriptions from `.meta()` and `messages`).

A **notifier kind** is `defineNotifier({ type, name, options, secretOptions, messages, send })`
from `@naosystem/cf-workers-status-page-core`. `secretOptions` lists the options that are
encrypted and never shown again. `send(notification, options, ctx)` lays out a notification
that is already written in `locale`; it throws a `NotifierError` saying whether a retry may help
(`expectSuccess(response, "Service")` does it for an HTTP response) and never puts a secret in a
message.

A **check provider** is `defineProvider({ type, options, requires: ["fetch"], check })`, which
returns the factory used in `status.config.ts`. Its options must not use the monitor settings'
keys (`id`, `interval`, …). Accept `secret()` references with `secretOr(z.string())` where a
value may be secret: `check(options, ctx)` receives the values. It returns
`{ state: "up" | "degraded" | "down", latencyMs?, message?, details? }`; on a timeout it may
just throw, and the check is recorded as `down`.

## <a id="api-reference"></a>API リファレンス / API reference

入出力は JSON で、時刻はエポックミリ秒です。`GET` が使えるところでは、どこでも `HEAD` も使えます。

JSON in and out; times are epoch milliseconds; `HEAD` works wherever `GET` does.

### <a id="public-api"></a>公開 API / Public API

誰でも使える読み取り専用の API です。応答の型は `shared/public-api.ts` にあります。表示するのはコンポーネントだけで、どのコンポーネントにも入っていない監視、監視の URL、チェックのメッセージ、管理者の名前は含みません。

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/health` | Worker が返す `{ "ok": true }`。キャッシュしません（`GET` のみで、`HEAD` は不可） |
| GET | `/api/pages` | 全ページの ID とタイトル |
| GET | `/api/pages/:pageId/status` | 全体の状態。各コンポーネントの状態（`up`、`degraded`、`down`、`unknown`）、メンテナンスのフラグ、応答時間を公開するかどうか（`latency`）。コンポーネントのグループ。未解決の障害告知とその経過。実施中と予定のメンテナンス。見た目（タイトル、説明、ロゴ、Web サイト、ファビコン、色）、テンプレート、`reportUrl`。D1 を読めなかったときは `incidentsOutdated` |
| GET | `/api/status` | 最初のページの状態 |
| GET | `/api/pages/:pageId/history` | コンポーネントごとの、`timezone` での過去90日間: 日ごとの稼働率、網羅率、停止と性能低下の時間、最も悪い状態、予定したチェック数と得られたチェック数、障害告知とメンテナンス、および期間全体での同じ値。キャッシュを作っている間、欠けている日は `pending` です（`complete: false`） |
| GET | `/api/pages/:pageId/stoppages` | 過去90日間にコンポーネントごとに確定した `down` の期間（新しい順） |
| GET | `/api/pages/:pageId/latency` | `latency: true` のコンポーネントの応答時間: 最新の値、直近24時間・7日間・30日間の平均の推移と、各期間の平均と95パーセンタイル（[テンプレート](#templates)）。公開するコンポーネントがなければ空の一覧。5分ごとに作り直し、キャッシュを作っている間は `complete: false` |
| GET | `/api/pages/:pageId/incidents?limit=&cursor=` | 未解決の障害告知（最初のページだけ）、続いて解決済みの告知をページ単位で。`limit` は1〜50で、10、20（既定）、50 のうち指定以上で最も小さいサイズで返します。`cursor` は前の応答の `nextCursor` でなければなりません（それ以外は `400`） |
| GET | `/api/pages/:pageId/incidents/:id?before=` | 障害告知と、その最新50件の経過（古い順）。それより前の経過があれば `olderUpdatesCursor` が設定されるので、それを `before` に渡すと、その前の50件を返します（作った値を渡すと `400`） |
| GET | `/api/pages/:pageId/images/:id` | アップロードしたロゴやファビコン（R2）。状態の `appearance.logoUrl` と `faviconUrl` がこのパスを指します。1年キャッシュ（`immutable`）し、`ETag` での再検証には `304` を返します。ない画像と R2 のないときは `404` |

Open to anyone, read-only. Response types are in `shared/public-api.ts`. Only components are
shown: no monitor that is in no component, no monitor URLs, check messages or administrator
names.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/health` | `{ "ok": true }` from the Worker, never cached (`GET` only, no `HEAD`) |
| GET | `/api/pages` | Every page's ID and title |
| GET | `/api/pages/:pageId/status` | Overall state; each component's state (`up`, `degraded`, `down`, `unknown`), maintenance flag and whether it publishes response times (`latency`); groups of components; unresolved incidents with their timelines; current and upcoming maintenance; appearance (title, description, logo, website, favicon, colours), template and `reportUrl`; `incidentsOutdated` when D1 could not be read |
| GET | `/api/status` | The first page's status |
| GET | `/api/pages/:pageId/history` | Per component, the last 90 days in `timezone`: uptime, coverage, time down and degraded, the worst state, scheduled and obtained checks, incidents and maintenance per day, and the same over the whole window. Missing days are `pending` while the cache fills (`complete: false`) |
| GET | `/api/pages/:pageId/stoppages` | Confirmed `down` periods per component in the last 90 days, newest first |
| GET | `/api/pages/:pageId/latency` | Response times of the components with `latency: true`: the latest, averages over the last 24 hours, 7 days and 30 days, and each period's average and 95th percentile ([Templates](#templates)). An empty list when none publishes them. Recomputed every 5 minutes; `complete: false` while the cache fills |
| GET | `/api/pages/:pageId/incidents?limit=&cursor=` | Unresolved incidents (first page only), then resolved ones by page. `limit` 1-50 is served as 10, 20 (the default) or 50, the next size up; `cursor` must be a `nextCursor` from a previous response (anything else gets `400`) |
| GET | `/api/pages/:pageId/incidents/:id?before=` | An incident with its latest 50 updates (oldest first). With older ones, `olderUpdatesCursor` is set: pass it as `before` for the 50 before them (a made-up one gets `400`) |
| GET | `/api/pages/:pageId/images/:id` | An uploaded logo or favicon (R2), where the status's `appearance.logoUrl` and `faviconUrl` point. Cached for a year (`immutable`); a revalidation with `ETag` gets `304`. `404` for an unknown image, or without R2 |

### <a id="admin-api"></a>管理 API / Admin API

管理者専用です（[管理画面へのアクセス](#admin-access-with-cloudflare-access)）。リクエストのスキーマは `shared/admin-api.ts` にあります。エラーは `{ "error": "<code>", "message": "…", "issues"?: [{ "path": [...], "message": "…", "code"?: "…", "params"?: { … } }] }` の形です。`issues` は検証で見つかった問題の場所を示し、`code` と `params` を使えば、クライアントは問題を自分の言語で伝えられます。一覧は `{ "items": [...], "nextCursor": "…" | null }` を新しい順に返し、`limit`（1〜100、既定50）と `cursor` を取ります。障害告知とメンテナンスの一覧には `page` が必要です。

**同時の編集.** 障害告知、メンテナンス、ページの見た目、通知先は `version` を持ちます。編集（`PATCH`、見た目では `PUT`）では、編集を始めたときの `version` を送り返します。その間に別の人が保存していれば何も保存せず、`409` `{ "error": "edit_conflict", "current": { … } }` を返します。一度も変更していないページの見た目の版は `0` です。経過の投稿は、コンポーネントの置き換えと `version` の送信を同時に行わない限り、競合しません。

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/admin/me` | ログイン中の管理者 |
| GET | `/api/admin/pages` | `status.config.ts` のページ（テンプレートを含む）とコンポーネント。画像をアップロードできるかどうか（`uploads`） |
| GET, PUT | `/api/admin/pages/:pageId/appearance` | タイトル、説明、ロゴの URL（https）、Web サイトの URL、ロゴ画像とファビコン（アップロードした画像の ID）、色（`{ light, dark }`、それぞれ `{ background, header, accent }` に `#rrggbb` か `null`）。PUT: `version` と最初の4項目すべて（既定に戻すには `null`）。`logoImage`、`faviconImage`、`colors` は省略すると今の値のまま |
| POST | `/api/admin/pages/:pageId/images` | 画像をアップロード: 本文は画像そのもので、`Content-Type` はその形式（`image/png`、`image/jpeg`、`image/gif`、`image/webp`、`image/x-icon`）。512 KB まで。`201` `{ id, url, contentType, size }`。中身が形式と違えば `400 invalid_image`、R2 がなければ `501 uploads_unavailable` |
| GET | `/api/admin/incidents?page=&status=open\|resolved` | ページの障害告知（経過は含まない） |
| POST | `/api/admin/incidents` | 作成: `pageId`、`title`、`body`（最初の経過）、`stage`（既定 `investigating`）、`components: [{ id, impact }]`、`startedAt`（もっと前に始まっていれば現在より前の時刻。未来は不可） |
| GET, PATCH, DELETE | `/api/admin/incidents/:id` | 経過付きで読む。`title` と `components` の一方または両方を変更（`version` 付き）。経過ごと削除 |
| POST | `/api/admin/incidents/:id/updates` | 経過を投稿: `stage`、`body`、任意で `components`（と `version`）。`resolved` 以外の状況を投稿すると、解決済みの告知が再開します |
| POST | `/api/admin/incidents/:id/resolve` | `resolved` の経過を投稿: `body` |
| GET | `/api/admin/maintenance?page=` | ページのメンテナンス（開始が新しい順） |
| POST | `/api/admin/maintenance` | 作成: `pageId`、`title`、`body`、`startsAt`、`endsAt`、`components: [id]` |
| GET, PATCH, DELETE | `/api/admin/maintenance/:id` | 読む。変更（`version` と一部の項目）。削除 |
| GET | `/api/admin/monitors` | 設定されている監視と、データが残っている削除済みの監視（それぞれの現在の状態付き） |
| DELETE | `/api/admin/monitors/:id` | 削除した監視のデータを削除。設定に残っている間やデプロイ中は `409 purge_refused`（`reason`: `configured`、`running`、`deploying`） |
| GET | `/api/admin/notifications/kinds` | 通知の種類。オプションの JSON Schema（秘密のオプションは `writeOnly`）、フォームの文言、暗号鍵が設定されているかどうかを含む |
| GET, POST | `/api/admin/notifications/targets` | 一覧。作成: `name`、`kind`、`options`、`admin`（既定 `false`）、`enabled`（既定 `true`）、`events`（既定は `down`、`recovered`。`admin` ならさらに `unknown`）、`allMonitors`（既定 `true`）、`monitors: [id]`、`components: [{ pageId, componentId }]` |
| GET, PATCH, DELETE | `/api/admin/notifications/targets/:id` | 読む（秘密情報は `secrets: { option: true }` の形）。変更（`version` 付き。`options` には変える項目だけを書き、`null` で削除。`url` を別のオリジンに移すには、ほかの秘密情報を入力し直す必要があり、なければ `secret_reentry_required`）。削除 |
| POST | `/api/admin/notifications/targets/:id/test` | テスト通知をすぐに送る: `{ ok, error }` |
| GET | `/api/admin/notifications/deliveries?status=` | 状態ごとの送信（既定は `failed`。ほかに `retrying`、`sending`、`sent`） |
| POST | `/api/admin/notifications/re-encrypt` | すべての通知先の秘密情報を、現在の鍵で、送信先に結び付けて暗号化し直す |

状況（stage）は `investigating`、`identified`、`monitoring`、`resolved`、影響度（impact）は `none`、`degraded`、`down` です。コンポーネント ID は、そのページのものでなければなりません。

For administrators only ([Admin access](#admin-access-with-cloudflare-access)). Request schemas
are in `shared/admin-api.ts`. Errors are
`{ "error": "<code>", "message": "…", "issues"?: [{ "path": [...], "message": "…", "code"?: "…", "params"?: { … } }] }`;
`issues` locate validation problems, and `code` and `params` let a client say them in its own
language. Lists return `{ "items": [...], "nextCursor": "…" | null }`, latest first, with `limit`
(1-100, default 50) and `cursor`; lists of incidents and maintenance need `page`.

**Concurrent edits.** Incidents, maintenance, page appearance and notification targets carry a
`version`. An edit (`PATCH`, or `PUT` for appearance) sends back the `version` it started from;
if someone else saved in between, nothing is saved and the answer is `409`
`{ "error": "edit_conflict", "current": { … } }`. A page never customised has appearance version
`0`. Posting a timeline update never conflicts, unless it also replaces the components and sends
a `version`.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/admin/me` | The signed-in administrator |
| GET | `/api/admin/pages` | Pages (with their template) and components from `status.config.ts`; whether images can be uploaded (`uploads`) |
| GET, PUT | `/api/admin/pages/:pageId/appearance` | Title, description, logo URL (https), website URL, logo image and favicon (IDs of uploaded images), colours (`{ light, dark }`, each `{ background, header, accent }` of `#rrggbb` or `null`). PUT: `version` and all of the first four (`null` for the default); `logoImage`, `faviconImage` and `colors` keep their values when left out |
| POST | `/api/admin/pages/:pageId/images` | Upload an image: the body is the image, with its type as `Content-Type` (`image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/x-icon`), up to 512 KB. `201` `{ id, url, contentType, size }`; `400 invalid_image` when the bytes are not of that type; `501 uploads_unavailable` without R2 |
| GET | `/api/admin/incidents?page=&status=open\|resolved` | A page's incidents, without timelines |
| POST | `/api/admin/incidents` | Create: `pageId`, `title`, `body` (first update), `stage` (default `investigating`), `components: [{ id, impact }]`, `startedAt` (earlier than now if it began earlier; never in the future) |
| GET, PATCH, DELETE | `/api/admin/incidents/:id` | Read with the timeline; change `title` and/or `components` (with `version`); delete with the timeline |
| POST | `/api/admin/incidents/:id/updates` | Post an update: `stage`, `body`, optionally `components` (and `version`). A stage other than `resolved` reopens a resolved incident |
| POST | `/api/admin/incidents/:id/resolve` | Post a `resolved` update: `body` |
| GET | `/api/admin/maintenance?page=` | A page's maintenance, latest start first |
| POST | `/api/admin/maintenance` | Create: `pageId`, `title`, `body`, `startsAt`, `endsAt`, `components: [id]` |
| GET, PATCH, DELETE | `/api/admin/maintenance/:id` | Read; change (`version` and some fields); delete |
| GET | `/api/admin/monitors` | Configured monitors, and removed ones whose data is kept, with their current state |
| DELETE | `/api/admin/monitors/:id` | Delete a removed monitor's data. `409 purge_refused` (`reason`: `configured`, `running` or `deploying`) while it is configured or a deploy is in progress |
| GET | `/api/admin/notifications/kinds` | Notifier kinds, with their options as JSON Schema (secret options `writeOnly`), their form's texts, and whether the encryption key is set |
| GET, POST | `/api/admin/notifications/targets` | List; create: `name`, `kind`, `options`, `admin` (default `false`), `enabled` (default `true`), `events` (default `down`, `recovered`, plus `unknown` for `admin`), `allMonitors` (default `true`), `monitors: [id]`, `components: [{ pageId, componentId }]` |
| GET, PATCH, DELETE | `/api/admin/notifications/targets/:id` | Read (secrets as `secrets: { option: true }`); change (`version`; `options` lists only what changes, `null` removes one; moving `url` to another origin needs the other secrets again, `secret_reentry_required`); delete |
| POST | `/api/admin/notifications/targets/:id/test` | Send a test notification now: `{ ok, error }` |
| GET | `/api/admin/notifications/deliveries?status=` | Deliveries by status (`failed` by default; `retrying`, `sending`, `sent`) |
| POST | `/api/admin/notifications/re-encrypt` | Encrypt every target's secrets with the current key, bound to its destination |

Stages are `investigating`, `identified`, `monitoring` and `resolved`; impacts are `none`,
`degraded` and `down`. Component IDs must belong to the page.

## <a id="license"></a>ライセンス / License

[MIT](./LICENSE)

モダンテンプレートのフォント（Inter と Noto Sans JP）は MIT ではなく、SIL Open Font License 1.1 で提供されています。著作権表示とライセンス文は [`public/licenses/fonts.txt`](./public/licenses/fonts.txt) にあり、デプロイしたサイトでは `/licenses/fonts.txt` で配信します。

The modern template's fonts (Inter and Noto Sans JP) are not under the MIT license but the SIL
Open Font License 1.1. Their copyright notices and license are in
[`public/licenses/fonts.txt`](./public/licenses/fonts.txt), served at `/licenses/fonts.txt` by a
deployed site.
