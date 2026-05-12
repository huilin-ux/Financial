# Apps Script sync

This repo is configured to push `Code.gs` to Google Apps Script with `clasp`.

## One-time local setup

```bash
npm install
npm run gas:login
```

After logging in, push local changes with:

```bash
npm run gas:push
```

For continuous local syncing while editing:

```bash
npm run gas:watch
```

## GitHub Actions auto-push

GitHub pushes to Apps Script automatically whenever `main` changes `Code.gs` or the Apps Script config files.

One repository secret is required.

```text
CLASPRC_JSON
```

Set it to the full contents of your local `~/.clasprc.json` after running `npm run gas:login`.

GitHub path:

```text
Settings -> Secrets and variables -> Actions -> New repository secret
```

If you also want the workflow to update an existing Web App deployment, add this optional repository secret:

```text
APPS_SCRIPT_DEPLOYMENT_ID
```

Without `APPS_SCRIPT_DEPLOYMENT_ID`, the workflow only runs `clasp push`. With it, the workflow also updates that deployment so the Web App keeps the same URL.
