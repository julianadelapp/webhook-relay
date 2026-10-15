# webhook-relay

A small, dependency-free TypeScript webhook relay. It receives a webhook once, verifies the signature, then **fans it out to several targets** with retries, so a slow or flaky downstream service never makes the sender give up.

```
GitHub / Stripe / Slack ──▶ POST /hooks/<route> ──▶ verify ──▶ 202 immediately
                                                       └──▶ background delivery to each target (retries + backoff)
                                                                 └──▶ dead-letter list for exhausted deliveries
```

## Configure

`relay.config.json` (or `RELAY_CONFIG_JSON`):

```json
{
  "routes": {
    "github": {
      "scheme": "github",
      "secret": "your-webhook-secret",
      "targets": ["http://localhost:3000/webhook", "http://localhost:4000/h/mirror"]
    }
  }
}
```

`scheme` is `github`, `stripe`, `slack` or `none`. Keep secrets out of the file in production by generating it from your secret store into `RELAY_CONFIG_JSON`.

## Run

```bash
npm install && npm run build
RELAY_ADMIN_TOKEN=change-me PORT=8787 npm start
```

Point your provider at `https://<host>/hooks/github`.

## Behavior

- **Fails closed.** A route without a secret (unless `none`) or a non-http(s) target stops startup.
- **Fast acknowledgement.** Responds `202` as soon as the signature checks out; delivery happens in the background.
- **Smart retries.** `5xx`, `408`, `429` and network errors retry with exponential backoff (4 attempts by default). Other `4xx` responses are permanent and are not retried.
- **No redirects.** Delivery uses `redirect: "manual"`, so a target can't bounce the payload elsewhere.
- **De-duplication.** Repeated `X-GitHub-Delivery` ids are acknowledged once and forwarded once.
- **Dead letters.** `GET /dead-letters` (needs `Authorization: Bearer $RELAY_ADMIN_TOKEN`; disabled if no token is set) lists deliveries that ran out of attempts. It stores metadata only, not payloads.
- **Graceful shutdown.** On `SIGTERM` it stops accepting requests and waits for in-flight deliveries.

Signature headers are passed through so downstream services can verify them again. The relay adds `X-Relay-Delivery` and `X-Relay-Route`.

## Develop

```bash
npm test
```

`src/verify.ts` is vendored from [webhook-verify](https://github.com/julianadelapp/webhook-verify) to keep this repo dependency-free.

## Ideas to extend

- Persistent queue (SQLite) so pending retries survive a restart
- Per-target payload filters and transforms
- Manual re-drive of dead letters

## License

MIT
