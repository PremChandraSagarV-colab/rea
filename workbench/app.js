const $ = (selector) => document.querySelector(selector);
const toast = (message) => { const el = $("#toast"); el.textContent = message; el.classList.add("show"); setTimeout(() => el.classList.remove("show"), 1800); };

function updateCommands() {
  const quote = (value) => value ? `"${value.replaceAll('"', '\\"')}"` : null;
  const endpoint = quote($("#cdp-endpoint").value) ?? '"http://127.0.0.1:9222"';
  const target = quote($("#target-id").value) ?? '"TARGET_ID_FROM_LIST"';
  $("#website-command").textContent = `rea inspect-web-page ${endpoint} ${target} --json`;
  const scenario = $("#scenario-url").value || "https://example.com";
  const scenarioJson = JSON.stringify({ browser: { mode: "launch", executable_path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" }, start_url: { url: scenario }, actions: [{ step_id: "open", action: "goto", destination: { url: scenario }, wait_until: "domcontentloaded" }], capture: { at_end: ["url"] } });
  $("#scenario-command").textContent = "rea capture-browser-scenario .\\scenario.json --json";
  $("#scenario-download").onclick = () => {
    const blob = new Blob([`${JSON.stringify(JSON.parse(scenarioJson), null, 2)}\n`], { type: "application/json" });
    const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = "scenario.json"; link.click(); URL.revokeObjectURL(link.href);
    toast("scenario.json downloaded");
  };
  const app = quote($("#app-path").value);
  $("#electron-command").textContent = app ? `rea analyze-javascript-application ${app} --json` : 'rea analyze-javascript-application "D:\\apps\\your-app" --json';
  const har = quote($("#har-path").value) ?? '"D:\\captures\\session.har"';
  $("#har-command").textContent = `rea inspect-web-network-capture ${har} ${$("#har-format").value} --json`;
}

for (const input of ["#cdp-endpoint", "#target-id", "#scenario-url", "#app-path", "#har-path", "#har-format"]) $(input).addEventListener("input", updateCommands);
document.querySelectorAll("[data-copy]").forEach((button) => button.addEventListener("click", async () => {
  const command = $(`#${button.dataset.copy}-command`).textContent;
  await navigator.clipboard.writeText(command); toast("Command copied");
}));
document.querySelectorAll("[data-copy-text]").forEach((button) => button.addEventListener("click", async () => { await navigator.clipboard.writeText(button.dataset.copyText); toast("Command copied"); }));

const gmailStatus = $("#gmail-status");
let latestScrape = [];
let latestVideos = [];
function downloadJson(filename, value) {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: "application/json" });
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = filename; link.click(); URL.revokeObjectURL(link.href);
}
function showMessage(container, text, className = "empty") {
  container.replaceChildren(Object.assign(document.createElement("p"), { className, textContent: text }));
}
function renderScrapeResults(container, items, filename = "web-scrape-results.json") {
  latestScrape = items; container.replaceChildren();
  const exportButton = Object.assign(document.createElement("button"), { className: "copy export-button", textContent: "Download JSON" });
  exportButton.addEventListener("click", () => downloadJson(filename, latestScrape)); container.append(exportButton);
  for (const item of items) {
    const card = document.createElement("article"); card.className = "scrape-result";
    const itemUrl = item.finalUrl ?? item.requestedUrl;
    card.append(Object.assign(document.createElement("h3"), { textContent: item.title || itemUrl }));
    if (itemUrl) card.append(Object.assign(document.createElement("a"), { href: itemUrl, target: "_blank", rel: "noreferrer", textContent: itemUrl }));
    if (!item.ok) card.append(Object.assign(document.createElement("p"), { className: "error", textContent: item.error }));
    else {
      if (item.description) card.append(Object.assign(document.createElement("p"), { className: "scrape-description", textContent: item.description }));
      card.append(Object.assign(document.createElement("p"), { className: "scrape-text", textContent: item.text || "No readable text found." }));
      card.append(Object.assign(document.createElement("small"), { textContent: `${item.depth !== undefined ? `Depth ${item.depth} · ` : ""}${item.headings?.length ?? 0} headings · ${item.links?.length ?? 0} links · HTTP ${item.status}` }));
    }
    container.append(card);
  }
}
async function refreshStatus() {
  try {
    const response = await fetch("/api/status");
    const status = await response.json();
    $("#connect-google").textContent = status.gmailConnected ? "Gmail connected ✓" : "Connect Gmail ↗";
    $("#connect-google").disabled = !status.gmailConfigured;
    $("#disconnect-google").disabled = !status.gmailConnected;
    gmailStatus.textContent = status.gmailConnected ? "Read-only connection active" : status.gmailConfigured ? "Not connected" : "Set Google OAuth credentials to enable";
    gmailStatus.className = `status ${status.gmailConnected ? "good" : ""}`;
    $("#gmail-form").classList.toggle("disabled", !status.gmailConnected);
    $("#youtube-status").textContent = status.youtubeConfigured ? "API key ready" : "Set YOUTUBE_API_KEY to enable";
    $("#youtube-status").className = `status ${status.youtubeConfigured ? "good" : ""}`;
  } catch { gmailStatus.textContent = "Workbench API unavailable"; }
}

$("#web-scrape-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const results = $("#scrape-results"); showMessage(results, "Fetching public pages…", "loading");
  const urls = $("#scrape-urls").value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
  try {
    const response = await fetch("/api/web/scrape", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ urls, selector: $("#scrape-selector").value }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "Scrape failed");
    renderScrapeResults(results, data.results);
  } catch (error) { showMessage(results, error.message, "error"); }
});

$("#crawl-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const results = $("#crawl-results"); showMessage(results, "Crawling same-origin pages…", "loading");
  try {
    const response = await fetch("/api/web/crawl", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: $("#crawl-url").value.trim(), maxPages: $("#crawl-limit").value, maxDepth: $("#crawl-depth").value, selector: $("#scrape-selector").value }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "Crawl failed");
    renderScrapeResults(results, data.results, "web-crawl-results.json");
  } catch (error) { showMessage(results, error.message, "error"); }
});

let latestRepositories = [];
$("#github-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const results = $("#github-results"); showMessage(results, "Searching public repositories…", "loading");
  try {
    const query = new URLSearchParams({ q: $("#github-query").value, sort: $("#github-sort").value });
    const response = await fetch(`/api/github/search?${query}`); const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "GitHub search failed");
    latestRepositories = data.repositories; results.replaceChildren();
    const exportButton = Object.assign(document.createElement("button"), { className: "copy export-button", textContent: "Download JSON" });
    exportButton.addEventListener("click", () => downloadJson("github-repositories.json", latestRepositories)); results.append(exportButton);
    if (!data.repositories.length) { showMessage(results, "No public repositories matched."); return; }
    for (const repo of data.repositories) {
      const card = document.createElement("article"); card.className = "repo-result";
      const head = document.createElement("div"); head.className = "repo-head";
      const name = Object.assign(document.createElement("a"), { href: repo.url, target: "_blank", rel: "noreferrer", textContent: repo.name }); name.className = "repo-name"; head.append(name);
      const activity = Object.assign(document.createElement("button"), { className: "copy", textContent: "Releases & issues" }); head.append(activity); card.append(head);
      card.append(Object.assign(document.createElement("p"), { className: "scrape-description", textContent: repo.description || "No description." }));
      card.append(Object.assign(document.createElement("small"), { textContent: `${repo.language || "Language n/a"} · ${repo.license || "License n/a"} · ★ ${Number(repo.stars).toLocaleString()} · ⑂ ${Number(repo.forks).toLocaleString()} · updated ${new Date(repo.updatedAt).toLocaleDateString()}` }));
      const detail = document.createElement("div"); detail.className = "repo-detail"; card.append(detail);
      activity.addEventListener("click", async () => {
        activity.disabled = true; activity.textContent = "Loading…";
        try {
          const path = repo.name.split("/").map(encodeURIComponent).join("/"); const response = await fetch(`/api/github/repos/${path}`); const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "Could not load repository activity");
          detail.replaceChildren();
          const releases = document.createElement("div"); releases.append(Object.assign(document.createElement("strong"), { textContent: "Recent releases" }));
          if (!data.releases.length) releases.append(Object.assign(document.createElement("p"), { className: "empty", textContent: "No published releases." }));
          for (const release of data.releases) { const link = Object.assign(document.createElement("a"), { href: release.url, target: "_blank", rel: "noreferrer", textContent: `${release.tag} · ${release.publishedAt ? new Date(release.publishedAt).toLocaleDateString() : "unpublished"}${release.prerelease ? " · prerelease" : ""}` }); releases.append(link); }
          const issues = document.createElement("div"); issues.append(Object.assign(document.createElement("strong"), { textContent: "Recently updated open issues" }));
          if (!data.issues.length) issues.append(Object.assign(document.createElement("p"), { className: "empty", textContent: "No open issues." }));
          for (const issue of data.issues) { const link = Object.assign(document.createElement("a"), { href: issue.url, target: "_blank", rel: "noreferrer", textContent: `#${issue.number} ${issue.title}` }); issues.append(link); }
          detail.append(releases, issues); activity.textContent = "Activity loaded";
        } catch (error) { detail.replaceChildren(Object.assign(document.createElement("p"), { className: "error", textContent: error.message })); activity.textContent = "Try again"; }
        finally { activity.disabled = false; }
      });
      results.append(card);
    }
  } catch (error) { showMessage(results, error.message, "error"); }
});

let latestFeed = null;
$("#feed-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const results = $("#feed-results"); showMessage(results, "Collecting feed entries…", "loading");
  try {
    const query = new URLSearchParams({ url: $("#feed-url").value.trim() });
    const response = await fetch(`/api/feeds/collect?${query}`); const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "Feed collection failed");
    latestFeed = data; results.replaceChildren();
    const head = document.createElement("div"); head.className = "feed-head";
    head.append(Object.assign(document.createElement("strong"), { textContent: data.title || "Public feed" }));
    const exportButton = Object.assign(document.createElement("button"), { className: "copy export-button", textContent: "Download JSON" }); exportButton.addEventListener("click", () => downloadJson("feed-entries.json", latestFeed)); head.append(exportButton); results.append(head);
    if (!data.entries.length) { showMessage(results, "No feed entries found."); return; }
    for (const entry of data.entries) {
      const card = document.createElement("article"); card.className = "feed-result";
      if (entry.url) { const link = Object.assign(document.createElement("a"), { href: entry.url, target: "_blank", rel: "noreferrer", textContent: entry.title || entry.url }); card.append(link); }
      else card.append(Object.assign(document.createElement("strong"), { textContent: entry.title || "Untitled entry" }));
      if (entry.publishedAt) card.append(Object.assign(document.createElement("time"), { textContent: entry.publishedAt }));
      if (entry.summary) card.append(Object.assign(document.createElement("p"), { className: "scrape-description", textContent: entry.summary }));
      results.append(card);
    }
  } catch (error) { showMessage(results, error.message, "error"); }
});

let chromeTargets = [];
function chromeQuery() {
  return new URLSearchParams({ endpoint: $("#chrome-endpoint").value.trim() || "http://127.0.0.1:9222" });
}
async function findChromeTargets() {
  const select = $("#chrome-target"); const status = $("#chrome-status");
  status.textContent = "Connecting to local Chrome…";
  try {
    const response = await fetch(`/api/chrome/targets?${chromeQuery()}`); const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "Could not connect to Chrome");
    chromeTargets = data.targets; select.replaceChildren();
    if (!chromeTargets.length) select.append(new Option("No open page tabs found", ""));
    for (const target of chromeTargets) select.append(new Option(`${target.title || "Untitled"} · ${target.url}`, target.id));
    status.textContent = `${chromeTargets.length} local tab${chromeTargets.length === 1 ? "" : "s"}`; status.className = "status good";
  } catch (error) {
    chromeTargets = []; select.replaceChildren(new Option("Chrome connection unavailable", "")); status.textContent = error.message; status.className = "status";
  }
  $("#chrome-inspect").disabled = !chromeTargets.length;
  $("#chrome-screenshot").disabled = !chromeTargets.length;
}
$("#chrome-form").addEventListener("submit", async (event) => { event.preventDefault(); await findChromeTargets(); });
$("#chrome-target").addEventListener("change", () => {
  const enabled = Boolean($("#chrome-target").value); $("#chrome-inspect").disabled = !enabled; $("#chrome-screenshot").disabled = !enabled;
});
async function inspectChrome(withScreenshot) {
  const results = $("#chrome-results"); showMessage(results, withScreenshot ? "Capturing the current tab…" : "Reading the current tab…", "loading");
  const query = chromeQuery(); query.set("id", $("#chrome-target").value); if (withScreenshot) query.set("screenshot", "1");
  try {
    const response = await fetch(`/api/chrome/inspect?${query}`); const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "Chrome inspection failed");
    results.replaceChildren();
    results.append(Object.assign(document.createElement("h3"), { className: "channel-title", textContent: data.title || "Untitled page" }));
    const url = Object.assign(document.createElement("a"), { href: data.url, target: "_blank", rel: "noreferrer", textContent: data.url }); url.className = "scrape-result-link"; results.append(url);
    results.append(Object.assign(document.createElement("p"), { className: "scrape-text", textContent: data.text || "No readable page text." }));
    if (data.screenshot) { const image = Object.assign(document.createElement("img"), { className: "chrome-shot", src: data.screenshot, alt: `Screenshot of ${data.title || data.url}` }); results.append(image); }
    const exportButton = Object.assign(document.createElement("button"), { className: "copy export-button", textContent: "Download page data" });
    const exported = { ...data }; delete exported.screenshot; exportButton.addEventListener("click", () => downloadJson("chrome-page-inspection.json", exported)); results.append(exportButton);
  } catch (error) { showMessage(results, error.message, "error"); }
}
$("#chrome-inspect").addEventListener("click", () => inspectChrome(false));
$("#chrome-screenshot").addEventListener("click", () => inspectChrome(true));

function renderYoutubeVideos(container, videos, channel = null) {
  latestVideos = videos; container.replaceChildren();
  if (channel) {
    const title = Object.assign(document.createElement("h3"), { className: "channel-title", textContent: `${channel.title} · ${Number(channel.videoCount || 0).toLocaleString()} videos` }); container.append(title);
    const stats = Object.assign(document.createElement("p"), { className: "scrape-description", textContent: `${Number(channel.subscribers || 0).toLocaleString()} subscribers · ${Number(channel.totalViews || 0).toLocaleString()} total views` }); container.append(stats);
  }
  const exportButton = Object.assign(document.createElement("button"), { className: "copy export-button", textContent: "Download JSON" });
  exportButton.addEventListener("click", () => downloadJson("youtube-video-results.json", channel ? { channel, videos: latestVideos } : latestVideos)); container.append(exportButton);
  if (!videos.length) { showMessage(container, "No videos found."); return; }
  for (const video of videos) {
    const card = document.createElement("article"); card.className = "video-result";
    if (video.thumbnail) { const image = Object.assign(document.createElement("img"), { src: video.thumbnail, alt: "", loading: "lazy" }); card.append(image); }
    const content = document.createElement("div");
    const title = Object.assign(document.createElement("a"), { href: video.url, target: "_blank", rel: "noreferrer", textContent: video.title }); title.className = "video-title"; content.append(title);
    content.append(Object.assign(document.createElement("p"), { className: "scrape-description", textContent: `${video.channel} · ${video.publishedAt ? new Date(video.publishedAt).toLocaleDateString() : "date unavailable"} · ${Number(video.views || 0).toLocaleString()} views` }));
    content.append(Object.assign(document.createElement("p"), { className: "scrape-text", textContent: video.description || "No description." }));
    content.append(Object.assign(document.createElement("small"), { textContent: `Duration ${video.duration || "unknown"} · Captions ${video.captions ? "available on video (download may require owner authorization)" : "not listed"}` }));
    card.append(content); container.append(card);
  }
}
async function showYoutubeResponse(responsePromise, loadingText) {
  const results = $("#youtube-results"); showMessage(results, loadingText, "loading");
  try { const response = await responsePromise; const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "YouTube collection failed"); renderYoutubeVideos(results, data.videos, data.channel); }
  catch (error) { showMessage(results, error.message, "error"); }
}
$("#youtube-form").addEventListener("submit", (event) => {
  event.preventDefault(); const query = new URLSearchParams({ q: $("#youtube-query").value, limit: $("#youtube-limit").value });
  showYoutubeResponse(fetch(`/api/youtube/search?${query}`), "Searching YouTube…");
});
$("#youtube-links-form").addEventListener("submit", (event) => {
  event.preventDefault(); const videos = $("#youtube-links").value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  showYoutubeResponse(fetch("/api/youtube/videos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ videos }) }), "Collecting video details…");
});
$("#youtube-channel-form").addEventListener("submit", (event) => {
  event.preventDefault(); const query = new URLSearchParams({ channel: $("#youtube-channel").value.trim(), limit: $("#youtube-channel-limit").value });
  showYoutubeResponse(fetch(`/api/youtube/channel?${query}`), "Collecting public channel uploads…");
});
$("#connect-google").addEventListener("click", () => { window.location.href = "/auth/google"; });
$("#disconnect-google").addEventListener("click", async () => {
  await fetch("/auth/disconnect", { method: "POST" });
  $("#gmail-results").replaceChildren();
  refreshStatus();
});
$("#gmail-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const results = $("#gmail-results");
  results.replaceChildren(Object.assign(document.createElement("p"), { className: "loading", textContent: "Searching your mailbox…" }));
  try {
    const query = new URLSearchParams({ q: $("#gmail-query").value, limit: $("#gmail-limit").value });
    const response = await fetch(`/api/gmail/search?${query}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Search failed");
    results.replaceChildren();
    if (!data.messages.length) { results.append(Object.assign(document.createElement("p"), { className: "empty", textContent: "No messages matched this query." })); return; }
    for (const message of data.messages) {
      const item = document.createElement("article"); item.className = "mail-result";
      const top = document.createElement("div"); top.className = "mail-result-top";
      const subject = document.createElement("strong"); subject.textContent = message.subject;
      const date = document.createElement("time"); date.textContent = message.date;
      top.append(subject, date);
      const from = document.createElement("div"); from.className = "mail-from"; from.textContent = message.from;
      const snippet = document.createElement("p"); snippet.textContent = message.snippet;
      item.append(top, from, snippet);
      const open = Object.assign(document.createElement("button"), { className: "copy message-open", textContent: "Open message" });
      open.addEventListener("click", async () => {
        open.disabled = true; open.textContent = "Loading…";
        try {
          const response = await fetch(`/api/gmail/messages/${encodeURIComponent(message.id)}`); const full = await response.json(); if (!response.ok) throw new Error(full.error ?? "Could not open message");
          const body = Object.assign(document.createElement("pre"), { className: "message-body", textContent: full.body || "This message has no extractable text body." });
          const previous = item.querySelector(".message-body, .attachment-list"); previous?.remove(); item.append(body);
          if (full.attachments.length) {
            const list = document.createElement("div"); list.className = "attachment-list";
            for (const attachment of full.attachments) {
              const link = Object.assign(document.createElement("a"), { href: `/api/gmail/messages/${encodeURIComponent(message.id)}/attachments/${encodeURIComponent(attachment.partId)}`, textContent: `Download ${attachment.filename} (${attachment.size} bytes)` }); link.setAttribute("download", attachment.filename); list.append(link);
            }
            item.append(list);
          }
          open.textContent = "Message opened";
        } catch (error) { open.textContent = error.message; } finally { open.disabled = false; }
      });
      item.append(open); results.append(item);
    }
  } catch (error) { results.replaceChildren(Object.assign(document.createElement("p"), { className: "error", textContent: error.message })); }
});

for (const link of document.querySelectorAll(".nav")) link.addEventListener("click", () => { document.querySelectorAll(".nav").forEach((item) => item.classList.remove("active")); link.classList.add("active"); });
refreshStatus(); updateCommands();
