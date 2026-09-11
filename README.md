# GitHub notification janitor

Tired of github filling up your notifications about bot comments on your own PRs? Just fork this repo and all useless notifications will disappear.

A GitHub Actions workflow that marks selected notifications Done. It keeps the
thread subscribed.

The included rules handle GitHub Actions comments on threads you created, your
own pull request state changes, and release updates. Rules use `@me`, which
resolves from the token at runtime. No account name is stored in the code.

## Fork and set up

1. Fork this repository.
2. Create a classic personal access token with the `repo` scope. Authorize it
   for each SAML SSO organization you use.
3. Add the token to the fork as the `NOTIFICATIONS_TOKEN` Actions secret.
4. Edit `.github/notification-janitor.json` for your rules.
5. Run **Notification janitor** from the Actions tab with **dry-run**. Review
   the workflow summary.
6. Run it with **apply** when the result is correct.

The scheduled job runs every day at 04:17 UTC. The included configuration runs
in apply mode. Set `dryRun` to `true` while you tune your rules.

## Rules

`commentAuthors` contains GitHub logins. Login matching ignores letter case.
`threadAuthors: ["@me"]` limits a rule to issues and pull requests you created.
Remove that field to allow a rule on threads from any author.

The janitor checks human activity after the last read time. It keeps the
notification when a human comment or review appears. It also keeps the newest
release notification from each repository for each week.

GitHub returns read and Done records through its notifications API. The janitor
uses a 30-hour activity window. This catches a new notification after you open
it, and avoids replaying old Done records every day.

## Test

```sh
node --experimental-transform-types --test .github/scripts/notification-janitor.test.ts
```

## Security

The workflow only reads repository activity and calls GitHub's Mark Done
notification endpoint. Logs hash notification references and omit repository
names, issue titles, and pull request titles.
