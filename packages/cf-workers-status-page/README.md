# @naosystem/cf-workers-status-page

Cloudflare Workers と Durable Objects で動く、セルフホストの死活監視とステータスページです。この npm パッケージを使うと、自分のリポジトリには設定（`status.config.ts` と `wrangler.jsonc`）だけを置き、本体はパッケージの版を上げて更新できます。

Self-hosted uptime monitoring and status pages on Cloudflare Workers and Durable Objects. With
this npm package, your repository holds only your configuration (`status.config.ts` and
`wrangler.jsonc`), and you update by raising the package's version.

```sh
git clone --depth 1 https://github.com/naosystem-jp/cf-workers-status-page.git
cp -r cf-workers-status-page/templates/starter my-status-page
cd my-status-page
npm install
npx wrangler login
npm run deploy
echo "k1:$(openssl rand -base64 32)" | npx wrangler secret put NOTIFICATION_KEYS
```

使い方、設定、運用のすべては、リポジトリの README にあります（日本語と英語）。

Everything else (setup, configuration, operation) is in the repository's README, in Japanese and
English: [Use the npm package](https://github.com/naosystem-jp/cf-workers-status-page#use-the-npm-package).

| Import | Contents |
| --- | --- |
| `@naosystem/cf-workers-status-page` | `defineConfig`, `component`, `secret`, `http` and the configuration's types |
| `@naosystem/cf-workers-status-page/notifier-slack`, `/notifier-discord`, `/notifier-webhook` | Notifier kinds |
| `@naosystem/cf-workers-status-page/auth-cloudflare-access` | Admin authentication with Cloudflare Access |
| `@naosystem/cf-workers-status-page/vite` | The Vite plugin (`statusPage()`) that builds the Worker |

1.0 までは、マイナーバージョンの更新でも互換性のない変更が入ることがあります。

Until 1.0, a minor version may bring incompatible changes.

## License

MIT. The status page and the admin UI include code from other packages, each under its own
license: see `dist/client/licenses/third-party.txt`. The bundled fonts (Inter and Noto Sans JP)
are under the SIL Open Font License 1.1: see `dist/client/licenses/fonts.txt`.
