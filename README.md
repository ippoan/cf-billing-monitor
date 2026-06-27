# cf-billing-monitor

毎朝 06:00 JST (cron `0 21 * * *` UTC) に日次レポートをメール配信する Cloudflare Worker。
配信は CF **Email Routing** の `send_email` binding (credential 不要) で
`m.tama.ramu@gmail.com` 宛、`mtamaramu.com` ゾーン発。

## 配信レポート (毎朝 2 通)

| 件名 | 内容 | ソース |
|---|---|---|
| `[CF Billing] YYYY-MM-DD 使用量レポート` | Workers / R2 / DO / Containers / Supabase の使用量・概算コスト・前日比・月累計 | CF GraphQL Analytics + Billing API + Supabase API |
| `[Flickr] YYYY-MM-DD …` | カメラ→Flickr パイプラインの撮影日別 (20 日窓) 登録/アップロード/検証と残数・消化位置 | [ippoan/rust-flickr](https://github.com/ippoan/rust-flickr) `GET /stats` (Refs #4) |

2 通は独立の try/catch で送る — 片方の失敗で他方を巻き込まない。

## 手動実行

billing は公開 HTTP パスから手動実行できる:

```sh
curl https://cf-billing-monitor.m-tama-ramu.workers.dev/trigger          # billing
```

flickr レポートは**外部公開していない**。手動トリガーは service binding 経由の
RPC method `triggerFlickrReport()` に集約してあり、外部 HTTP からはメール送信を
発火できない (cron による日次配信は従来どおり)。binding を持つ別 Worker から:

```ts
await env.CF_BILLING_MONITOR.triggerFlickrReport();
```

## 構成

| path | 役割 |
|---|---|
| `src/index.ts` | scheduled / fetch handler、billing レポート本体 (`runReport`) |
| `src/flickr-report.ts` | flickr レポート (`/stats` fetch → HTML → mimetext) |
| `src/email.ts` | billing メールの HTML 組み立て |
| `src/graphql.ts` / `src/billing.ts` / `src/supabase.ts` | 各種メトリクス取得 |
| `src/pricing.ts` / `src/storage.ts` | 料金計算 / KV 履歴 (前日比・月累計) |

## bindings / vars (wrangler.toml)

- `EMAIL` — `send_email` (destination は Email Routing で verify 済みであること)
- `CF_API_TOKEN` / `SUPABASE_PAT` — CF Secrets Store
- `BILLING_HISTORY` — KV (日次スナップショット)
- `CF_ACCOUNT_ID` / `RUST_FLICKR_URL` / `FLICKR_REPORT_ORG` — plain vars

## デプロイ

PR merge で CI (`frontend-ci.yml`) が `npx wrangler deploy` を実行する (single-env)。
手動 deploy は不要。
