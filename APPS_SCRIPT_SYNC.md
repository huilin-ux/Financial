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

## Optional GitHub Actions auto-push

You can also make GitHub push to Apps Script automatically whenever `main` changes `Code.gs`.

One repository secret is required:

```text
CLASPRC_JSON
```

Set it to the full contents of your local `~/.clasprc.json` after running `npm run gas:login`.

GitHub path:

```text
Settings -> Secrets and variables -> Actions -> New repository secret
```

Then add this workflow at `.github/workflows/apps-script-push.yml`:

```yaml
name: Push Apps Script

on:
  push:
    branches:
      - main
    paths:
      - Code.gs
      - appsscript.json
      - .clasp.json
      - package.json
      - package-lock.json
      - .github/workflows/apps-script-push.yml
  workflow_dispatch:

jobs:
  push:
    runs-on: ubuntu-latest
    steps:
      - name: Check out repository
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install clasp
        run: npm install

      - name: Write clasp credentials
        env:
          CLASPRC_JSON: ${{ secrets.CLASPRC_JSON }}
        run: |
          if [ -z "$CLASPRC_JSON" ]; then
            echo "Missing repository secret: CLASPRC_JSON"
            exit 1
          fi
          printf '%s' "$CLASPRC_JSON" > ~/.clasprc.json

      - name: Push files to Apps Script
        run: npm run gas:push
```
