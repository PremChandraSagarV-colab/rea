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
  } catch { gmailStatus.textContent = "Workbench API unavailable"; }
}
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
      item.append(top, from, snippet); results.append(item);
    }
  } catch (error) { results.replaceChildren(Object.assign(document.createElement("p"), { className: "error", textContent: error.message })); }
});

for (const link of document.querySelectorAll(".nav")) link.addEventListener("click", () => { document.querySelectorAll(".nav").forEach((item) => item.classList.remove("active")); link.classList.add("active"); });
refreshStatus(); updateCommands();
