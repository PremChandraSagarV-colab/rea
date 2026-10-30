# REA Workbench

A lightweight UI around the workflows in [`morluto/rea`](https://github.com/morluto/rea), with browser-session and reverse-engineering command builders, a bounded public-page scraper, a Gmail reader, and a YouTube video collector.

## Run locally

```powershell
Copy-Item workbench/.env.example workbench/.env
Push-Location workbench
npm ci
node server.mjs
```

Edit `.env` with your values. Open `http://localhost:3000`. The dashboard can run without configuring Gmail or YouTube; those connectors become available when their credentials are set. To use REA analysis commands, return to the repository root, install its dependencies, and run `npm run build:cached`. REA's native and browser analysis runs on the same machine as its CLI; the web dashboard does not grant a hosted Render service access to your local files or desktop.

### Run build tasks with Codex

Install and sign in to the Codex CLI on your PC, then run `npm run local` from `workbench/` and open `http://localhost:3000`. This enables **Build task agent** and runs prompts through `codex exec` with workspace-write sandboxing and Codex automatic approval review. Enter an existing absolute project folder in the dashboard; by default it is the REA repository root. One task runs at a time, is limited to 30 minutes, and its output stays in memory until the server restarts. The task runner is disabled in production and the server binds to loopback locally. It can edit the selected workspace and run project commands; review its changes. Logins, secrets, external publishing, and production deployments may require you to complete a separate approval or account step. This is a coding agent built around the Codex CLI, not the REA reverse-engineering MCP product.

Run `npm test` in `workbench/` for a mock-provider integration check of Gmail search/body/attachment routes and YouTube search/video/channel collection.

### Chrome inspection

Start a separate Chrome profile with remote debugging enabled, then select **Find tabs** in the local dashboard. For Chrome 136 and later, Chrome requires a non-default profile for the remote debugging switch. For example, in PowerShell (adjust the Chrome executable path if needed):

```powershell
& "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:LOCALAPPDATA\REA\ChromeProfile"
```

The workbench only connects to `localhost`, `127.0.0.1`, or `::1`; it can list open tabs, read the selected tab's rendered title/text/links, and capture a screenshot. Use a dedicated profile because a remote debugging connection can access that profile's open pages and session data. A hosted Render service cannot reach Chrome on your PC, so this feature works with the local workbench.

## Web scraper

Enter one to ten public HTML or plain-text page URLs, optionally with a CSS selector, crawl one site from a seed URL with a 1–50 page limit and depth up to three, or collect up to 50 pages listed in a sitemap (including up to five same-origin sitemap index files). Crawls follow same-origin links only. It extracts the page title, description, canonical URL, headings, up to 100 links, and up to 30,000 characters of readable text. Requests follow the site's `robots.txt` rules and are limited to standard web ports, five redirects, 15 seconds, and 5 MB per page. Local/private/reserved IP targets and non-HTML resources are blocked. The scraper does not execute page JavaScript, load browser sessions, or bypass access controls; single-page apps may need the local Chrome/REA workflows instead.

## GitHub explorer

Search public repositories by language, topic, or name, then inspect recent published releases and open issues. It uses the official unauthenticated REST API for public repositories, so it does not expose private GitHub account data and is subject to GitHub's public API rate limits.

## RSS and Atom feeds

Collect up to 50 titles, published dates, links, and summaries from a public RSS or Atom feed. The fetch follows the site's `robots.txt`, uses the same public-network protections and 5 MB response limit as the web scraper, and exports results as JSON.

## Gmail setup

Create a Google OAuth client of type **Web application**, enable the Gmail API, and register the callback URL exactly as `GOOGLE_REDIRECT_URI`. For local work, use `http://localhost:3000/auth/google/callback`. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` in `workbench/.env`. The app asks only for `gmail.readonly`: it searches message metadata/snippets, opens full text on request, and downloads selected attachments. It cannot send, modify, or delete email. Google classifies `gmail.readonly` as a restricted scope; review its current verification requirements before offering this app to other users. Access and refresh tokens are held in process memory for a 24-hour inactive session; nothing is stored in a mailbox database or on disk. Access tokens refresh automatically while the service process is running. Restarting the server disconnects the session. The Disconnect button ends the current app session; revoke the app separately from your Google Account permissions to remove its grant.

## YouTube collector

Enable **YouTube Data API v3** for a Google Cloud project, create an API key restricted to that API, and set `YOUTUBE_API_KEY` in `workbench/.env` or the Render service environment. Search uses the official YouTube Data API, then retrieves public video details and statistics. You can also collect details from up to 50 pasted video IDs/URLs or the latest 250 public uploads from a channel ID or @handle. Search API quota is limited by Google's project quota. Caption availability is shown when listed; downloading captions for other channels' videos is not offered because YouTube requires OAuth authorization for caption tracks and the API does not expose those captions to arbitrary public searches. This module does not download video files.

Google OAuth consent-screen verification and user eligibility are controlled by Google's current project settings. Keep the app in test mode with only intended test users until your OAuth configuration is ready for broader use.

## Render

The repository's `render.yaml` deploys this workbench as a Render web service without building REA on the hosted instance. It uses Render's free compute plan; free services spin down after 15 minutes idle, and in-memory Gmail sessions end when the process stops. Set all `sync: false` environment variables in the Render dashboard. Use a unique long `WORKBENCH_PASSWORD`, then set `GOOGLE_REDIRECT_URI` to `https://YOUR-SERVICE.onrender.com/auth/google/callback` and add the same URL to the Google OAuth client. Set `YOUTUBE_API_KEY` to enable YouTube search. Keep secrets in Render's environment settings; never commit them. Render prompts for `sync: false` values during initial Blueprint creation; update secrets for an existing service in its dashboard. The password gate uses HTTP Basic Authentication and ignores the username, so enter any username (for example `rea`) with the password. If you forget the password, replace `WORKBENCH_PASSWORD` in the service's Render Environment settings and redeploy. The local Codex task runner is disabled in production by design; the hosted service cannot take over your PC.

When deployed, submitted page URLs are fetched by the Render host. Gmail message text is retrieved on request and selected attachments are streamed through the host; do not deploy or connect accounts unless you accept that data flow. REA analysis of local binaries, desktop apps, or local Chrome targets remains on the local machine.

## REA source and license

REA is distributed under MIT; its original `LICENSE`, attribution, and third-party notices are retained. This workbench is a separate addition and does not claim to be an upstream REA product.
