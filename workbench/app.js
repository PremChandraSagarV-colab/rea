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
    latestScrape = data.results;
    results.replaceChildren();
    const exportButton = Object.assign(document.createElement("button"), { className: "copy export-button", textContent: "Download JSON" });
    exportButton.addEventListener("click", () => downloadJson("web-scrape-results.json", latestScrape)); results.append(exportButton);
    for (const item of data.results) {
      const card = document.createElement("article"); card.className = "scrape-result";
      const title = Object.assign(document.createElement("h3"), { textContent: item.title || item.requestedUrl }); card.append(title);
      const url = Object.assign(document.createElement("a"), { href: item.finalUrl ?? item.requestedUrl, target: "_blank", rel: "noreferrer", textContent: item.finalUrl ?? item.requestedUrl }); card.append(url);
      if (!item.ok) card.append(Object.assign(document.createElement("p"), { className: "error", textContent: item.error }));
      else {
        if (item.description) card.append(Object.assign(document.createElement("p"), { className: "scrape-description", textContent: item.description }));
        card.append(Object.assign(document.createElement("p"), { className: "scrape-text", textContent: item.text || "No readable text found." }));
        card.append(Object.assign(document.createElement("small"), { textContent: `${item.headings.length} headings · ${item.links.length} links · HTTP ${item.status}` }));
      }
      results.append(card);
    }
  } catch (error) { showMessage(results, error.message, "error"); }
});

$("#youtube-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const results = $("#youtube-results"); showMessage(results, "Searching YouTube…", "loading");
  try {
    const query = new URLSearchParams({ q: $("#youtube-query").value, limit: $("#youtube-limit").value });
    const response = await fetch(`/api/youtube/search?${query}`); const data = await response.json(); if (!response.ok) throw new Error(data.error ?? "YouTube search failed");
    latestVideos = data.videos; results.replaceChildren();
    const exportButton = Object.assign(document.createElement("button"), { className: "copy export-button", textContent: "Download JSON" });
    exportButton.addEventListener("click", () => downloadJson("youtube-video-results.json", latestVideos)); results.append(exportButton);
    if (!data.videos.length) { showMessage(results, "No videos matched."); return; }
    for (const video of data.videos) {
      const card = document.createElement("article"); card.className = "video-result";
      if (video.thumbnail) { const image = Object.assign(document.createElement("img"), { src: video.thumbnail, alt: "", loading: "lazy" }); card.append(image); }
      const content = document.createElement("div");
      const title = Object.assign(document.createElement("a"), { href: video.url, target: "_blank", rel: "noreferrer", textContent: video.title }); title.className = "video-title"; content.append(title);
      content.append(Object.assign(document.createElement("p"), { className: "scrape-description", textContent: `${video.channel} · ${video.publishedAt ? new Date(video.publishedAt).toLocaleDateString() : "date unavailable"} · ${Number(video.views || 0).toLocaleString()} views` }));
      content.append(Object.assign(document.createElement("p"), { className: "scrape-text", textContent: video.description || "No description." }));
      content.append(Object.assign(document.createElement("small"), { textContent: `Duration ${video.duration || "unknown"} · Captions ${video.captions ? "available on video (download may require owner authorization)" : "not listed"}` }));
      card.append(content); results.append(card);
    }
  } catch (error) { showMessage(results, error.message, "error"); }
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
