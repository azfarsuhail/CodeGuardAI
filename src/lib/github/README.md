# GitHub App PR reviews (PRD Phase 3, FR-080..083)

On every opened / reopened / synchronized / ready-for-review (non-draft) pull request, CodeGuard reviews up to 10
changed files, posts one PR review (summary + up to 30 inline comments on lines the PR introduced) and a
`CodeGuard AI` check run (`failure` on new critical/high, `neutral` on new medium, else `success`).

- `client.ts`: config, webhook signature check, app JWT, REST client (DB-free, unit tested)
- `review.ts`: patch parsing, introduced-vs-pre-existing split, comment and summary formatting (DB-free, unit tested)
- `process.ts`: the background job (fetch files, run the pipeline, persist, post to GitHub)
- Webhook: `src/app/api/integrations/github/webhook/route.ts`

## Create the GitHub App

GitHub → Settings → Developer settings → GitHub Apps → New GitHub App:

- **Webhook URL**: `https://<your-domain>/api/integrations/github/webhook`
- **Webhook secret**: a long random string (same value as `GITHUB_WEBHOOK_SECRET`)
- **Repository permissions**: Pull requests: Read & write · Contents: Read · Checks: Read & write · Metadata: Read
- **Subscribe to events**: Pull request (installation events are delivered automatically)
- After creating it, note the **App ID** and generate a **private key** (.pem), then install the app on the repositories to review.

## Environment variables

| Variable | Value |
|---|---|
| `GITHUB_APP_ID` | The App ID |
| `GITHUB_APP_PRIVATE_KEY` | The .pem contents; a single line with literal `\n` escapes also works |
| `GITHUB_WEBHOOK_SECRET` | The webhook secret |

If any is missing, the webhook answers `503 not_configured`.
