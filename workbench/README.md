# REA Workbench

A lightweight UI around the workflows in [`morluto/rea`](https://github.com/morluto/rea), with command builders for web, browser-session, Electron, and HAR analysis and an optional read-only Gmail search using Google's official API.

## Run locally

```powershell
Copy-Item workbench/.env.example workbench/.env
node workbench/server.mjs
```

Edit `workbench/.env` with your values. Open `http://localhost:3000`. The dashboard can run without configuring Gmail; connect Google OAuth to use the mailbox panel. To use REA analysis commands, install a supported Node.js version and dependencies with `npm ci`, then build REA with `npm run build:cached`. REA's native and browser analysis runs on the same machine as its CLI; the web dashboard does not grant a hosted Render service access to your local files or desktop.

## Gmail setup

Create a Google OAuth client of type **Web application**, enable the Gmail API, and register the callback URL exactly as `GOOGLE_REDIRECT_URI`. For local work, use `http://localhost:3000/auth/google/callback`. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` in `workbench/.env`. The app asks only for `gmail.readonly`, searches message metadata and snippets, and does not send, modify, or delete email. Google classifies `gmail.readonly` as a restricted scope; review its current verification requirements before offering this app to other users. Access and refresh tokens are held in process memory for a 24-hour inactive session; nothing is stored in a mailbox database or on disk. Access tokens refresh automatically while the service process is running. Restarting the server disconnects the session. The Disconnect button ends the current app session; revoke the app separately from your Google Account permissions to remove its grant.

Google OAuth consent-screen verification and user eligibility are controlled by Google's current project settings. Keep the app in test mode with only intended test users until your OAuth configuration is ready for broader use.

## Render

The repository's `render.yaml` deploys this workbench as a Render web service without building REA on the hosted instance. It uses Render's free compute plan; free services spin down after 15 minutes idle, and the in-memory Gmail session ends when that happens. Set all `sync: false` environment variables in the Render dashboard. Use a unique long `WORKBENCH_PASSWORD`, then set `GOOGLE_REDIRECT_URI` to `https://YOUR-SERVICE.onrender.com/auth/google/callback` and add the same URL to the Google OAuth client. Keep secrets in Render's environment settings; never commit them. Render prompts for `sync: false` values during initial Blueprint creation; update secrets for an existing service in its dashboard.

Deploying the Gmail-enabled service means matching email snippets are processed by the Render host for the duration of the request. Deploy only after you are comfortable with that data flow. REA analysis of local binaries, desktop apps, or local Chrome targets remains on the local machine.

## REA source and license

REA is distributed under MIT; its original `LICENSE`, attribution, and third-party notices are retained. This workbench is a separate addition and does not claim to be an upstream REA product.
