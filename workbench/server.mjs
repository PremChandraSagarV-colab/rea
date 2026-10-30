import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as cheerio from "cheerio";
import puppeteer from "puppeteer-core";

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 3000);
const production = process.env.NODE_ENV === "production";
const sessions = new Map();
const localAgentTasks = new Map();
let activeLocalAgentTask = null;
const sessionCookie = "rea_session";
const sessionTtlMs = 24 * 60 * 60 * 1000;

try {
  const envText = await readFile(join(root, ".env"), "utf8");
  for (const line of envText.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, "$2");
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

if (production && !process.env.WORKBENCH_PASSWORD) {
  throw new Error("Set WORKBENCH_PASSWORD before exposing the workbench publicly.");
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie ?? "").split(";").map((part) => {
    const i = part.indexOf("=");
    return i < 0 ? ["", ""] : [part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim())];
  }));
}

function send(res, status, body, type = "application/json; charset=utf-8", headers = {}) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data: https://i.ytimg.com; connect-src 'self'", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

function sendFile(res, status, body, type, filename) {
  res.writeHead(status, { "content-type": type, "content-length": body.length, "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'" });
  res.end(body);
}

async function readJson(req, limit = 32_000) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new Error("Request body is too large."); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("Request body must be valid JSON."); }
}

function auth(req, res) {
  const secret = process.env.WORKBENCH_PASSWORD;
  if (!secret) return true;
  const match = /^Basic\s+(.+)$/i.exec(req.headers.authorization ?? "");
  if (match) {
    let decoded = "";
    try { decoded = Buffer.from(match[1], "base64").toString("utf8").split(":").slice(1).join(":"); } catch {}
    if (safeEqual(decoded, secret)) return true;
  }
  send(res, 401, "Workbench password required", "text/plain; charset=utf-8", { "www-authenticate": 'Basic realm="REA Workbench", charset="UTF-8"' });
  return false;
}

function cookieOptions(value, maxAge) {
  return `${sessionCookie}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${production ? "; Secure" : ""}`;
}

function localAgentEnabled() {
  return !production && process.env.LOCAL_AGENT_ENABLED === "true";
}

function appendTaskLog(task, text) {
  if (!text) return;
  task.output = `${task.output}${text}`.slice(-80_000);
  task.updatedAt = new Date().toISOString();
}

function startLocalAgentTask(prompt) {
  const task = { id: randomBytes(12).toString("hex"), prompt, status: "queued", output: "", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), exitCode: null };
  localAgentTasks.set(task.id, task);
  activeLocalAgentTask = task.id;
  task.status = "running";
  const workspace = process.env.LOCAL_AGENT_WORKSPACE || dirname(root);
  const executable = process.env.CODEX_CLI_PATH || "codex";
  const safeEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(?:PASSWORD|SECRET|TOKEN|API_KEY|CLIENT_ID|CREDENTIAL)/i.test(name)));
  const taskPrompt = `You are Codex running locally for the user. Work in the configured project workspace until the requested deliverable is implemented and verified. Inspect the existing project before changing it. Use the project's established conventions and run relevant checks. Never read, print, or transmit .env files, credentials, auth stores, or secret values; do not bypass authentication, CAPTCHAs, paywalls, or site access controls. Do not send email, publish externally, create public repositories, or deploy unless the user's task explicitly names and authorizes that specific action. If a requested action needs a password, API key, OAuth consent, CAPTCHA, or consequential external approval, stop at that step and tell the user exactly what to complete. For local browser automation, only use an explicitly configured loopback Chrome DevTools endpoint such as http://127.0.0.1:9222; never probe other machines or network ranges.\n\nUSER TASK:\n${prompt}`;
  let child;
  try {
    child = spawn(executable, ["exec", "--cd", workspace, "--model", process.env.CODEX_MODEL || "gpt-6-luna", "--approve-for-me", "--json", "-"], { cwd: workspace, env: safeEnv, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    task.status = "failed";
    appendTaskLog(task, `Could not start Codex CLI: ${error.message}\n`);
    activeLocalAgentTask = null;
    return task;
  }
  task.pid = child.pid ?? null;
  task.child = child;
  let stdoutBuffer = "";
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    const lines = stdoutBuffer.split(/\r?\n/); stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === "item.completed" && event.item?.type === "agent_message") appendTaskLog(task, `${event.item.text ?? ""}\n`);
        else if (event.type === "turn.started") appendTaskLog(task, "Codex started a new turn.\n");
        else if (event.type === "turn.completed") appendTaskLog(task, "Codex completed the task turn.\n");
        else if (event.type === "turn.failed" || event.type === "error") appendTaskLog(task, `${event.message ?? event.error?.message ?? "Codex reported an error."}\n`);
      } catch { appendTaskLog(task, `${line}\n`); }
    }
  });
  child.stderr.on("data", (chunk) => appendTaskLog(task, chunk.toString("utf8")));
  child.on("error", (error) => {
    task.status = "failed"; appendTaskLog(task, `Could not run Codex CLI: ${error.message}\n`);
    if (activeLocalAgentTask === task.id) activeLocalAgentTask = null;
  });
  const timeout = setTimeout(() => { if (task.status === "running") { task.status = "timed_out"; appendTaskLog(task, "Local agent reached the 30-minute limit and was stopped.\n"); child.kill(); } }, 30 * 60 * 1000);
  timeout.unref();
  child.on("close", (code, signal) => {
    clearTimeout(timeout);
    task.exitCode = code;
    if (task.status === "running") task.status = code === 0 ? "completed" : "failed";
    if (signal) appendTaskLog(task, `Codex exited on signal ${signal}.\n`);
    if (activeLocalAgentTask === task.id) activeLocalAgentTask = null;
  });
  child.stdin.end(taskPrompt);
  return task;
}

function getSession(req) {
  const id = cookies(req)[sessionCookie];
  const session = id ? sessions.get(id) : undefined;
  if (!session) return undefined;
  if (Date.now() - session.lastSeenAt > sessionTtlMs) {
    sessions.delete(id);
    return undefined;
  }
  session.lastSeenAt = Date.now();
  return session;
}

async function googleToken(fields) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...fields, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_description ?? data.error ?? "Google OAuth request failed");
  return data;
}

async function sessionAccessToken(session) {
  if (session.accessToken && session.tokenExpiresAt > Date.now() + 30_000) return session.accessToken;
  if (!session.refreshToken) return null;
  const tokens = await googleToken({ grant_type: "refresh_token", refresh_token: session.refreshToken });
  session.accessToken = tokens.access_token;
  session.tokenExpiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1000;
  return session.accessToken;
}

async function gmailSearch(token, query, maxResults) {
  const params = new URLSearchParams({ q: query, maxResults: String(maxResults) });
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Gmail search failed (${response.status})`);
  const { messages = [] } = await response.json();
  return Promise.all(messages.map(async ({ id }) => {
    const item = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`, { headers: { authorization: `Bearer ${token}` } });
    if (!item.ok) throw new Error(`Could not read message metadata (${item.status})`);
    const message = await item.json();
    const headers = Object.fromEntries((message.payload?.headers ?? []).map(({ name, value }) => [name.toLowerCase(), value]));
    return { id: message.id, from: headers.from ?? "", to: headers.to ?? "", subject: headers.subject ?? "(no subject)", date: headers.date ?? "", snippet: message.snippet ?? "", attachments: [] };
  }));
}

function blockedAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split(".").map(Number);
    const n = (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]) >>> 0;
    const ranges = [[0x00000000,8],[0x0a000000,8],[0x64400000,10],[0x7f000000,8],[0xa9fe0000,16],[0xac100000,12],[0xc0000000,24],[0xc0000200,24],[0xc0586300,24],[0xc0a80000,16],[0xc6120000,15],[0xc6336400,24],[0xcb007100,24],[0xe0000000,4],[0xf0000000,4]];
    return ranges.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)));
  }
  if (family === 6) return !/^[23]/i.test(address) || /^2001:db8:/i.test(address);
  return true;
}

async function publicTarget(input) {
  let url;
  try { url = new URL(input); } catch { throw new Error("Enter a valid http or https URL."); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Only public http and https URLs are supported.");
  if (url.port && !["80", "443"].includes(url.port)) throw new Error("Only standard web ports 80 and 443 are allowed.");
  const literalFamily = isIP(url.hostname);
  const addresses = literalFamily ? [{ address: url.hostname, family: literalFamily }] : await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => blockedAddress(address))) throw new Error("Private, reserved, or local network targets are blocked.");
  return { url, pin: addresses[0] };
}

async function fetchPublicPage(input, redirects = 0) {
  const { url, pin } = await publicTarget(input);
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  const responseData = await new Promise((resolve, reject) => {
    const req = request(url, { method: "GET", timeout: 15_000, lookup: (_host, options, callback) => options?.all ? callback(null, [pin]) : callback(null, pin.address, pin.family), autoSelectFamily: false, headers: { "user-agent": "REA-Workbench/1.0 (+https://github.com/PremChandraSagarV-colab/rea)", accept: "text/html,application/xhtml+xml,text/plain;q=0.9", "accept-encoding": "identity" } }, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        res.resume(); resolve({ redirect: new URL(res.headers.location, url).href }); return;
      }
      if (res.statusCode < 200 || res.statusCode >= 300) { res.resume(); reject(new Error(`Target returned HTTP ${res.statusCode}.`)); return; }
      const type = String(res.headers["content-type"] ?? "").toLowerCase();
      if (!/(text\/html|application\/xhtml\+xml|text\/plain|application\/(?:rss\+xml|atom\+xml|xml)|text\/xml)/.test(type)) { res.resume(); reject(new Error("Target is not an HTML, XML, RSS, or Atom text resource.")); return; }
      if (Number(res.headers["content-length"] ?? 0) > 5_000_000) { res.destroy(); reject(new Error("Page exceeds the 5 MB limit.")); return; }
      const chunks = []; let size = 0;
      res.on("data", (chunk) => { size += chunk.length; if (size > 5_000_000) { res.destroy(new Error("Page exceeds the 5 MB limit.")); return; } chunks.push(chunk); });
      res.on("end", () => resolve({ buffer: Buffer.concat(chunks), type, status: res.statusCode, finalUrl: url.href }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("Page request timed out.")));
    req.on("error", reject); req.end();
  });
  if (responseData.redirect) {
    if (redirects >= 4) throw new Error("The page redirected too many times.");
    return fetchPublicPage(responseData.redirect, redirects + 1);
  }
  return responseData;
}

async function scrapePage(input, selector = "") {
  const initial = await checkRobots(input);
  const page = await fetchPublicPage(input);
  const $ = cheerio.loadBuffer(page.buffer);
  const title = $("title").first().text().trim();
  const description = $("meta[name='description']").attr("content") ?? $("meta[property='og:description']").attr("content") ?? "";
  const canonical = $("link[rel='canonical']").attr("href") ?? page.finalUrl;
  let chosen = selector.trim() ? $(selector) : $("main, article").first();
  if (!chosen.length) chosen = $("body");
  const text = chosen.text().replace(/\s+/g, " ").trim().slice(0, 30_000);
  const links = $("a[href]").toArray().slice(0, 100).flatMap((el) => { try { const target = new URL($(el).attr("href"), page.finalUrl); return ["http:", "https:"].includes(target.protocol) ? [{ text: $(el).text().replace(/\s+/g, " ").trim().slice(0, 250), url: target.href }] : []; } catch { return []; } });
  return { requestedUrl: input, finalUrl: page.finalUrl, status: page.status, title, description: description.slice(0, 1000), canonical, headings: $("h1,h2,h3").toArray().slice(0, 40).map((el) => $(el).text().replace(/\s+/g, " ").trim()).filter(Boolean), text, links };
}

async function crawlSite(seed, maxPages, maxDepth, selector = "") {
  const initial = await publicTarget(seed);
  const origin = initial.url.origin;
  const normalize = (value) => { const url = new URL(value); url.hash = ""; return url.href; };
  const visited = new Set(); const results = []; let frontier = [{ url: normalize(initial.url.href), depth: 0 }];
  while (frontier.length && results.length < maxPages) {
    const batch = frontier.splice(0, Math.min(3, maxPages - results.length));
    const pages = await Promise.all(batch.map(async (entry) => {
      visited.add(entry.url);
      try { return { entry, result: { ok: true, depth: entry.depth, ...(await scrapePage(entry.url, selector)) } }; }
      catch (error) { return { entry, result: { ok: false, depth: entry.depth, requestedUrl: entry.url, error: error.message } }; }
    }));
    for (const { entry, result } of pages) {
      results.push(result);
      if (!result.ok || entry.depth >= maxDepth) continue;
      for (const link of result.links) {
        try {
          const target = new URL(link.url);
          const candidate = normalize(target.href);
          if (target.origin === origin && !visited.has(candidate) && !frontier.some((next) => next.url === candidate)) frontier.push({ url: candidate, depth: entry.depth + 1 });
        } catch {}
      }
    }
    if (frontier.length > maxPages - results.length) frontier.length = maxPages - results.length;
  }
  return { seedUrl: seed, origin, maxPages, maxDepth, count: results.length, results };
}

async function collectSitemap(input, maxUrls, selector = "") {
  const initial = await checkRobots(input);
  const origin = initial.url.origin;
  const queue = [initial.url.href]; const visitedMaps = new Set(); const pageUrls = new Set();
  while (queue.length && visitedMaps.size < 5 && pageUrls.size < maxUrls) {
    const mapUrl = queue.shift();
    if (visitedMaps.has(mapUrl)) continue;
    visitedMaps.add(mapUrl);
    await checkRobots(mapUrl);
    const page = await fetchPublicPage(mapUrl);
    if (!/(xml|rss|atom)/.test(page.type)) throw new Error("Sitemap must be an XML document.");
    const $ = cheerio.loadBuffer(page.buffer, { xmlMode: true });
    const locations = $("sitemapindex > sitemap > loc, urlset > url > loc").toArray().map((node) => $(node).text().trim()).filter(Boolean);
    if (!locations.length) throw new Error("No sitemap locations found in this XML document.");
    for (const location of locations) {
      try {
        const target = new URL(location, page.finalUrl);
        if (!(["http:", "https:"].includes(target.protocol) && target.origin === origin)) continue;
        target.hash = "";
        if ($("sitemapindex").length) {
          if (!visitedMaps.has(target.href) && !queue.includes(target.href) && queue.length < 5) queue.push(target.href);
        } else if (pageUrls.size < maxUrls) pageUrls.add(target.href);
      } catch {}
      if (pageUrls.size >= maxUrls) break;
    }
  }
  const urls = [...pageUrls]; const results = [];
  for (let i = 0; i < urls.length; i += 3) {
    const batch = await Promise.all(urls.slice(i, i + 3).map(async (target) => {
      try { return { ok: true, ...(await scrapePage(target, selector)) }; }
      catch (error) { return { ok: false, requestedUrl: target, error: error.message }; }
    }));
    results.push(...batch);
  }
  return { sitemapUrl: input, origin, count: results.length, results };
}

async function checkRobots(input) {
  const initial = await publicTarget(input);
  let robots = "";
  try {
    const policy = await fetchPublicPage(new URL("/robots.txt", initial.url).href);
    robots = policy.buffer.toString("utf8");
  } catch (error) {
    if (!/HTTP (404|410)/.test(error.message)) throw new Error(`Could not verify this site's robots.txt: ${error.message}`);
  }
  if (!robotsAllows(robots, initial.url)) throw new Error("This page is disallowed by the site's robots.txt policy.");
  return initial;
}

async function collectFeed(input) {
  const target = await checkRobots(input);
  const page = await fetchPublicPage(input);
  const parsed = parseFeedDocument(page.buffer, page.finalUrl);
  return { feedUrl: page.finalUrl, ...parsed, fetchedAt: new Date().toISOString(), count: parsed.entries.length, robotsCheckedFor: target.url.origin };
}

export function parseFeedDocument(buffer, baseUrl) {
  const $ = cheerio.loadBuffer(buffer, { xmlMode: true });
  const feedTitle = $("channel > title, feed > title").first().text().trim();
  const siteUrl = $("channel > link").first().text().trim() || $("feed > link[rel='alternate']").first().attr("href") || baseUrl;
  const entries = $("item, entry").toArray().slice(0, 50).map((element) => {
    const item = $(element);
    const title = item.children("title").first().text().trim();
    const linkNode = item.children("link").first();
    const rawLink = linkNode.attr("href") ?? linkNode.text().trim() ?? item.children("guid").first().text().trim();
    let link = ""; if (rawLink) { try { const resolved = new URL(rawLink, baseUrl); if (["http:", "https:"].includes(resolved.protocol)) link = resolved.href; } catch {} }
    const summary = item.children("description, summary, content\\:encoded, content").first().text().trim();
    const date = item.children("pubDate, published, updated, dc\\:date").first().text().trim();
    return { title, url: link, publishedAt: date, summary: cheerio.load(summary).text().replace(/\s+/g, " ").trim().slice(0, 4000) };
  });
  let resolvedSiteUrl = baseUrl; try { const resolved = new URL(siteUrl, baseUrl); if (["http:", "https:"].includes(resolved.protocol)) resolvedSiteUrl = resolved.href; } catch {}
  return { title: feedTitle, siteUrl: resolvedSiteUrl, entries };
}

function robotsAllows(robots, url) {
  const groups = []; let group = null;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.split("#", 1)[0].trim(); if (!line) continue;
    const sep = line.indexOf(":"); if (sep < 0) continue;
    const key = line.slice(0, sep).trim().toLowerCase(); const value = line.slice(sep + 1).trim();
    if (key === "user-agent") {
      if (!group || group.rulesStarted) { group = { agents: [], rules: [], rulesStarted: false }; groups.push(group); }
      group.agents.push(value.toLowerCase());
    } else if ((key === "allow" || key === "disallow") && group) {
      group.rulesStarted = true; if (value) group.rules.push({ allow: key === "allow", value });
    }
  }
  const agent = "rea-workbench";
  const relevant = groups.map((g) => ({ ...g, score: Math.max(0, ...g.agents.filter((name) => name !== "*" && agent.includes(name)).map((name) => name.length)) })).filter((g) => g.score > 0);
  const selected = relevant.length ? relevant : groups.filter((g) => g.agents.includes("*"));
  const target = `${url.pathname}${url.search}`;
  const matches = selected.flatMap((g) => g.rules).filter((rule) => {
    const expression = `^${rule.value.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}${rule.value.endsWith("$") ? "" : ".*"}$`;
    return new RegExp(expression).test(target);
  }).sort((a, b) => b.value.replace(/[*$]/g, "").length - a.value.replace(/[*$]/g, "").length || Number(b.allow) - Number(a.allow));
  return !matches.length || matches[0].allow;
}

function collectMailParts(part, result) {
  if (!part) return;
  const filename = part.filename ?? "";
  if (filename && part.body?.attachmentId) result.attachments.push({ partId: part.partId, attachmentId: part.body.attachmentId, filename, mimeType: part.mimeType ?? "application/octet-stream", size: part.body.size ?? 0 });
  if (part.body?.data) {
    const text = Buffer.from(part.body.data, "base64url").toString("utf8");
    if (part.mimeType === "text/plain") result.plain.push(text);
    else if (part.mimeType === "text/html") result.html.push(text);
  }
  for (const child of part.parts ?? []) collectMailParts(child, result);
}

async function gmailMessage(token, messageId) {
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Could not read message (${response.status}).`);
  const message = await response.json();
  const headers = Object.fromEntries((message.payload?.headers ?? []).map(({ name, value }) => [name.toLowerCase(), value]));
  const parts = { plain: [], html: [], attachments: [] }; collectMailParts(message.payload, parts);
  let body = parts.plain.join("\n\n").trim();
  if (!body && parts.html.length) body = cheerio.load(parts.html.join("\n"))("body").text().replace(/\s+/g, " ").trim();
  return { id: message.id, from: headers.from ?? "", to: headers.to ?? "", subject: headers.subject ?? "(no subject)", date: headers.date ?? "", body: body.slice(0, 100_000), attachments: parts.attachments };
}

async function youtubeSearch(query, maxResults) {
  const params = new URLSearchParams({ key: process.env.YOUTUBE_API_KEY, part: "snippet", type: "video", maxResults: String(maxResults), q: query });
  const response = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message ?? `YouTube API returned HTTP ${response.status}.`);
  const ids = (data.items ?? []).map((item) => item.id?.videoId).filter(Boolean);
  return youtubeVideos(ids);
}

async function youtubeVideos(ids) {
  if (!ids.length) return [];
  const videos = [];
  for (let i = 0; i < ids.length; i += 50) {
    const detailsParams = new URLSearchParams({ key: process.env.YOUTUBE_API_KEY, part: "snippet,contentDetails,statistics", id: ids.slice(i, i + 50).join(",") });
    const detailsResponse = await fetch(`https://www.googleapis.com/youtube/v3/videos?${detailsParams}`);
    const details = await detailsResponse.json();
    if (!detailsResponse.ok) throw new Error(details.error?.message ?? `YouTube API returned HTTP ${detailsResponse.status}.`);
    videos.push(...(details.items ?? []).map((video) => ({ id: video.id, title: video.snippet?.title ?? "", description: video.snippet?.description ?? "", channel: video.snippet?.channelTitle ?? "", publishedAt: video.snippet?.publishedAt ?? "", duration: video.contentDetails?.duration ?? "", views: video.statistics?.viewCount ?? "", likes: video.statistics?.likeCount ?? "", thumbnail: video.snippet?.thumbnails?.medium?.url ?? video.snippet?.thumbnails?.default?.url ?? "", url: `https://www.youtube.com/watch?v=${video.id}`, captions: video.contentDetails?.caption === "true" })));
  }
  return videos;
}

async function youtubeChannel(input, limit) {
  const channelQuery = new URLSearchParams({ key: process.env.YOUTUBE_API_KEY, part: "snippet,contentDetails,statistics" });
  if (/^UC[\w-]{22}$/.test(input)) channelQuery.set("id", input);
  else channelQuery.set("forHandle", input.replace(/^@/, ""));
  const channelResponse = await fetch(`https://www.googleapis.com/youtube/v3/channels?${channelQuery}`);
  const channelData = await channelResponse.json();
  if (!channelResponse.ok) throw new Error(channelData.error?.message ?? `YouTube API returned HTTP ${channelResponse.status}.`);
  const channel = channelData.items?.[0]; if (!channel) throw new Error("No public channel matched that channel ID or @handle.");
  const uploadsId = channel.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsId) throw new Error("The channel's public uploads playlist is unavailable.");
  const ids = []; let pageToken = "";
  while (ids.length < limit) {
    const params = new URLSearchParams({ key: process.env.YOUTUBE_API_KEY, part: "snippet", playlistId: uploadsId, maxResults: String(Math.min(50, limit - ids.length)) });
    if (pageToken) params.set("pageToken", pageToken);
    const response = await fetch(`https://www.googleapis.com/youtube/v3/playlistItems?${params}`);
    const page = await response.json();
    if (!response.ok) throw new Error(page.error?.message ?? `YouTube API returned HTTP ${response.status}.`);
    ids.push(...(page.items ?? []).map((item) => item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId).filter(Boolean));
    pageToken = page.nextPageToken ?? ""; if (!pageToken) break;
  }
  const videos = await youtubeVideos(ids);
  return { channel: { id: channel.id, title: channel.snippet?.title ?? "", description: channel.snippet?.description ?? "", url: `https://www.youtube.com/channel/${channel.id}`, subscribers: channel.statistics?.subscriberCount ?? "", totalViews: channel.statistics?.viewCount ?? "", videoCount: channel.statistics?.videoCount ?? "" }, videos };
}

function youtubeVideoId(input) {
  if (/^[\w-]{11}$/.test(input)) return input;
  try {
    const url = new URL(input); const host = url.hostname.toLowerCase();
    if (host === "youtu.be") return url.pathname.split("/").filter(Boolean)[0] ?? null;
    if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(host)) {
      if (url.pathname === "/watch") return url.searchParams.get("v");
      const match = /^\/(?:shorts|embed|live)\/([\w-]{11})/.exec(url.pathname); return match?.[1] ?? null;
    }
  } catch {}
  return null;
}

async function githubApi(path) {
  const response = await fetch(`https://api.github.com${path}`, { headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "REA-Workbench" } });
  const data = await response.json();
  if (!response.ok) {
    const reset = response.headers.get("x-ratelimit-reset");
    const wait = reset ? ` Try again after ${new Date(Number(reset) * 1000).toLocaleTimeString()}.` : "";
    throw new Error(`${data.message ?? `GitHub API returned HTTP ${response.status}`}${wait}`);
  }
  return data;
}

async function githubSearch(query, sort) {
  const params = new URLSearchParams({ q: query, sort, order: "desc", per_page: "10" });
  const result = await githubApi(`/search/repositories?${params}`);
  return (result.items ?? []).map((repo) => ({ name: repo.full_name, description: repo.description ?? "", url: repo.html_url, stars: repo.stargazers_count ?? 0, forks: repo.forks_count ?? 0, issues: repo.open_issues_count ?? 0, language: repo.language ?? "", license: repo.license?.spdx_id ?? "", updatedAt: repo.updated_at, defaultBranch: repo.default_branch }));
}

async function githubRepoDetails(owner, repo) {
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const [releases, issues] = await Promise.all([githubApi(`${base}/releases?per_page=5`), githubApi(`${base}/issues?state=open&sort=updated&direction=desc&per_page=10`)]);
  return {
    releases: releases.map((item) => ({ tag: item.tag_name, name: item.name ?? item.tag_name, publishedAt: item.published_at, url: item.html_url, prerelease: item.prerelease })),
    issues: issues.filter((item) => !item.pull_request).slice(0, 5).map((item) => ({ number: item.number, title: item.title, state: item.state, updatedAt: item.updated_at, url: item.html_url, labels: item.labels.map((label) => label.name) })),
  };
}

function localChromeEndpoint(input) {
  let endpoint;
  try { endpoint = new URL(input || "http://127.0.0.1:9222"); } catch { throw new Error("Enter a valid local Chrome DevTools URL."); }
  if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname.toLowerCase()) || endpoint.username || endpoint.password || !["", "/"].includes(endpoint.pathname) || endpoint.search || endpoint.hash) throw new Error("Chrome connections are restricted to a local http endpoint such as http://127.0.0.1:9222.");
  return endpoint.origin;
}

async function withChrome(endpointInput, action) {
  const endpoint = localChromeEndpoint(endpointInput);
  const browser = await puppeteer.connect({ browserURL: endpoint, defaultViewport: null, protocolTimeout: 10_000 });
  try { return await action(browser); } finally { await browser.disconnect(); }
}

async function chromeTargets(browser) {
  const pages = browser.targets().filter((target) => target.type() === "page").slice(0, 50);
  return Promise.all(pages.map(async (target) => {
    const session = await target.createCDPSession();
    try {
      const { targetInfo } = await session.send("Target.getTargetInfo");
      return { id: targetInfo.targetId, title: targetInfo.title, url: targetInfo.url };
    } finally { await session.detach(); }
  }));
}

async function chromePage(browser, targetId) {
  if (!/^[\w-]{1,128}$/.test(targetId)) throw new Error("Invalid Chrome target ID.");
  const pages = browser.targets().filter((target) => target.type() === "page");
  for (const target of pages) {
    const session = await target.createCDPSession();
    let found;
    try { found = (await session.send("Target.getTargetInfo")).targetInfo.targetId === targetId; }
    finally { await session.detach(); }
    if (found) return target.page();
  }
  throw new Error("That Chrome tab is no longer open. Refresh the target list.");
}

async function inspectChromeTarget(browser, targetId, includeScreenshot) {
  const page = await chromePage(browser, targetId);
  if (!page) throw new Error("Chrome target is not a page.");
  const details = await page.evaluate(() => ({
    title: document.title,
    url: location.href,
    description: document.querySelector('meta[name="description"]')?.content ?? "",
    headings: Array.from(document.querySelectorAll("h1,h2,h3")).slice(0, 40).map((item) => item.innerText.trim()).filter(Boolean),
    text: (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 20_000),
    links: Array.from(document.querySelectorAll("a[href]")).slice(0, 100).map((item) => ({ text: item.innerText.trim().slice(0, 250), url: item.href })),
  }));
  if (includeScreenshot) details.screenshot = `data:image/jpeg;base64,${(await page.screenshot({ type: "jpeg", quality: 55, fullPage: false })).toString("base64")}`;
  return details;
}

export const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === "/auth/google/callback") {
      const session = getSession(req);
      const state = url.searchParams.get("state") ?? "";
      if (!session || !state || !safeEqual(state, session.oauthState ?? "")) return send(res, 400, "OAuth state check failed", "text/plain; charset=utf-8");
      if (url.searchParams.get("error")) return send(res, 400, "Google authorization was cancelled", "text/plain; charset=utf-8");
      const tokens = await googleToken({ code: url.searchParams.get("code") ?? "", redirect_uri: process.env.GOOGLE_REDIRECT_URI, grant_type: "authorization_code" });
      session.accessToken = tokens.access_token;
      session.refreshToken = tokens.refresh_token;
      session.tokenExpiresAt = Date.now() + (tokens.expires_in ?? 3600) * 1000;
      session.oauthState = undefined;
      res.writeHead(302, { location: "/", "set-cookie": cookieOptions(cookies(req)[sessionCookie], 86_400), "cache-control": "no-store" });
      return res.end();
    }
    if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, "ok", "text/plain; charset=utf-8");
    if (!auth(req, res)) return;

    if (req.method === "GET" && url.pathname === "/api/local-agent/status") {
      const active = activeLocalAgentTask ? localAgentTasks.get(activeLocalAgentTask) : null;
      return send(res, 200, { enabled: localAgentEnabled(), workspace: localAgentEnabled() ? process.env.LOCAL_AGENT_WORKSPACE || dirname(root) : null, activeTask: active ? { id: active.id, status: active.status, output: active.output, createdAt: active.createdAt, updatedAt: active.updatedAt } : null, tasks: [...localAgentTasks.values()].slice(-10).reverse().map(({ id, status, output, createdAt, updatedAt, exitCode }) => ({ id, status, output, createdAt, updatedAt, exitCode })) });
    }
    if (req.method === "POST" && url.pathname === "/api/local-agent/tasks") {
      if (!localAgentEnabled()) return send(res, 503, { error: "The task runner is local-only. Start this workbench on your computer with LOCAL_AGENT_ENABLED=true." });
      const origin = req.headers.origin;
      if (!origin || new URL(origin).host !== req.headers.host || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname)) return send(res, 403, { error: "A same-origin local workbench request is required." });
      if (activeLocalAgentTask) return send(res, 409, { error: "One local task is already running. Stop it or wait for it to finish." });
      const input = await readJson(req);
      if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 20_000) return send(res, 400, { error: "Enter a task prompt up to 20,000 characters." });
      for (const [id, task] of localAgentTasks) if (task.status !== "running" && localAgentTasks.size > 20) localAgentTasks.delete(id);
      const task = startLocalAgentTask(input.prompt.trim());
      return send(res, 202, { task: { id: task.id, status: task.status, output: task.output, createdAt: task.createdAt, updatedAt: task.updatedAt } });
    }
    const localTaskCancel = /^\/api\/local-agent\/tasks\/([a-f0-9]{24})\/cancel$/.exec(url.pathname);
    if (req.method === "POST" && localTaskCancel) {
      if (!localAgentEnabled()) return send(res, 503, { error: "The task runner is local-only." });
      const origin = req.headers.origin;
      if (!origin || new URL(origin).host !== req.headers.host || !["localhost", "127.0.0.1"].includes(new URL(origin).hostname)) return send(res, 403, { error: "A same-origin local workbench request is required." });
      const task = localAgentTasks.get(localTaskCancel[1]);
      if (!task || task.status !== "running" || !task.child) return send(res, 404, { error: "No running task found." });
      task.status = "cancelled"; appendTaskLog(task, "Stopped by the user.\n"); task.child.kill();
      return send(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/api/status") {
      let id = cookies(req)[sessionCookie];
      let session = id && sessions.get(id);
      if (!session) {
        if (sessions.size >= 256) {
          const oldest = sessions.keys().next().value;
          if (oldest) sessions.delete(oldest);
        }
        id = randomBytes(32).toString("hex");
        session = { lastSeenAt: Date.now() };
        sessions.set(id, session);
      }
      for (const [key, value] of sessions) if (Date.now() - value.lastSeenAt > sessionTtlMs) sessions.delete(key);
      return send(res, 200, { gmailConfigured: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI), gmailConnected: Boolean(session.refreshToken || (session.accessToken && session.tokenExpiresAt > Date.now())), youtubeConfigured: Boolean(process.env.YOUTUBE_API_KEY) }, "application/json; charset=utf-8", { "set-cookie": cookieOptions(id, 86_400) });
    }
    if (req.method === "GET" && url.pathname === "/api/chrome/targets") {
      let endpoint;
      try { endpoint = localChromeEndpoint(url.searchParams.get("endpoint") ?? "http://127.0.0.1:9222"); }
      catch (error) { return send(res, 400, { error: error.message }); }
      try { return send(res, 200, { targets: await withChrome(endpoint, chromeTargets) }); }
      catch { return send(res, 503, { error: "Could not reach Chrome. Start a local Chrome session with remote debugging on this port." }); }
    }
    if (req.method === "GET" && url.pathname === "/api/chrome/inspect") {
      let endpoint;
      try { endpoint = localChromeEndpoint(url.searchParams.get("endpoint") ?? "http://127.0.0.1:9222"); }
      catch (error) { return send(res, 400, { error: error.message }); }
      const targetId = url.searchParams.get("id") ?? "";
      if (!/^[\w-]{1,128}$/.test(targetId)) return send(res, 400, { error: "Choose a valid Chrome tab to inspect." });
      try {
        const details = await withChrome(endpoint, (browser) => inspectChromeTarget(browser, targetId, url.searchParams.get("screenshot") === "1"));
        return send(res, 200, details);
      } catch (error) { return send(res, 503, { error: error.message }); }
    }
    if (req.method === "GET" && url.pathname === "/auth/google") {
      if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REDIRECT_URI) return send(res, 503, "Google OAuth is not configured", "text/plain; charset=utf-8");
      const sid = cookies(req)[sessionCookie];
      const session = sid && sessions.get(sid);
      if (!session) return send(res, 401, "Open the workbench first to create a session", "text/plain; charset=utf-8");
      const state = randomBytes(32).toString("hex");
      session.oauthState = state;
      const params = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: process.env.GOOGLE_REDIRECT_URI, response_type: "code", scope: "https://www.googleapis.com/auth/gmail.readonly", access_type: "offline", prompt: "consent", include_granted_scopes: "true", state });
      res.writeHead(302, { location: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, "cache-control": "no-store" });
      return res.end();
    }
    if (req.method === "GET" && url.pathname === "/api/gmail/search") {
      const session = getSession(req);
      if (!session) return send(res, 401, { error: "Connect your Gmail account first." });
      const query = (url.searchParams.get("q") ?? "").trim();
      if (!query) return send(res, 400, { error: "Enter a Gmail search query." });
      if (query.length > 500) return send(res, 400, { error: "Gmail search queries are limited to 500 characters." });
      const requested = Number(url.searchParams.get("limit") ?? 10);
      const maxResults = Number.isFinite(requested) ? Math.min(25, Math.max(1, Math.floor(requested))) : 10;
      const accessToken = await sessionAccessToken(session);
      if (!accessToken) return send(res, 401, { error: "Connect your Gmail account first." });
      const messages = await gmailSearch(accessToken, query, maxResults);
      return send(res, 200, { messages, count: messages.length });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/gmail/messages/")) {
      const session = getSession(req); if (!session) return send(res, 401, { error: "Connect your Gmail account first." });
      const accessToken = await sessionAccessToken(session); if (!accessToken) return send(res, 401, { error: "Connect your Gmail account first." });
      const attachmentMatch = /^\/api\/gmail\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(url.pathname);
      if (attachmentMatch) {
        const messageId = decodeURIComponent(attachmentMatch[1]); const partId = decodeURIComponent(attachmentMatch[2]);
        const message = await gmailMessage(accessToken, messageId);
        const attachment = message.attachments.find((item) => item.partId === partId);
        if (!attachment) return send(res, 404, { error: "Attachment not found." });
        if (attachment.size > 25_000_000) return send(res, 413, { error: "Attachment is larger than the 25 MB download limit." });
        const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachment.attachmentId)}`, { headers: { authorization: `Bearer ${accessToken}` } });
        if (!response.ok) throw new Error(`Could not download attachment (${response.status}).`);
        const data = await response.json();
        const content = Buffer.from(data.data ?? "", "base64url");
        const filename = attachment.filename.replace(/[\r\n"\\/]/g, "_").slice(0, 180) || "gmail-attachment";
        return sendFile(res, 200, content, attachment.mimeType, filename);
      }
      const messageId = decodeURIComponent(url.pathname.slice("/api/gmail/messages/".length));
      if (!/^[\w-]{1,256}$/.test(messageId)) return send(res, 400, { error: "Invalid message ID." });
      const full = await gmailMessage(accessToken, messageId);
      return send(res, 200, { ...full, attachments: full.attachments.map(({ partId, filename, mimeType, size }) => ({ partId, filename, mimeType, size })) });
    }
    if (req.method === "POST" && url.pathname === "/api/web/scrape") {
      const input = await readJson(req);
      const urls = Array.isArray(input.urls) ? input.urls : [];
      if (!urls.length || urls.length > 10 || urls.some((item) => typeof item !== "string" || item.length > 2048)) return send(res, 400, { error: "Provide 1 to 10 page URLs, each no longer than 2048 characters." });
      if (typeof input.selector === "string" && input.selector.length > 200) return send(res, 400, { error: "CSS selector is limited to 200 characters." });
      const results = [];
      for (let i = 0; i < urls.length; i += 3) {
        const batch = await Promise.all(urls.slice(i, i + 3).map(async (target) => { try { return { ok: true, ...(await scrapePage(target, input.selector ?? "")) }; } catch (error) { return { ok: false, requestedUrl: target, error: error.message }; } }));
        results.push(...batch);
      }
      return send(res, 200, { results });
    }
    if (req.method === "POST" && url.pathname === "/api/web/crawl") {
      const input = await readJson(req);
      if (typeof input.url !== "string" || input.url.length > 2048) return send(res, 400, { error: "Enter a starting URL up to 2048 characters." });
      const maxPages = Math.min(50, Math.max(1, Math.floor(Number(input.maxPages) || 20)));
      const maxDepth = Math.min(3, Math.max(0, Math.floor(Number(input.maxDepth) || 0)));
      if (typeof input.selector === "string" && input.selector.length > 200) return send(res, 400, { error: "CSS selector is limited to 200 characters." });
      return send(res, 200, await crawlSite(input.url, maxPages, maxDepth, input.selector ?? ""));
    }
    if (req.method === "GET" && url.pathname === "/api/web/sitemap") {
      const sitemapUrl = url.searchParams.get("url") ?? "";
      if (!sitemapUrl || sitemapUrl.length > 2048) return send(res, 400, { error: "Enter a sitemap URL up to 2048 characters." });
      const maxUrls = Math.min(50, Math.max(1, Math.floor(Number(url.searchParams.get("limit") ?? 20) || 20)));
      const selector = url.searchParams.get("selector") ?? "";
      if (selector.length > 200) return send(res, 400, { error: "CSS selector is limited to 200 characters." });
      return send(res, 200, await collectSitemap(sitemapUrl, maxUrls, selector));
    }
    if (req.method === "GET" && url.pathname === "/api/youtube/search") {
      if (!process.env.YOUTUBE_API_KEY) return send(res, 503, { error: "Set YOUTUBE_API_KEY to enable official YouTube search." });
      const query = (url.searchParams.get("q") ?? "").trim();
      if (!query || query.length > 300) return send(res, 400, { error: "Enter a YouTube query up to 300 characters." });
      const count = Math.min(25, Math.max(1, Number(url.searchParams.get("limit") ?? 10) || 10));
      return send(res, 200, { videos: await youtubeSearch(query, count) });
    }
    if (req.method === "POST" && url.pathname === "/api/youtube/videos") {
      if (!process.env.YOUTUBE_API_KEY) return send(res, 503, { error: "Set YOUTUBE_API_KEY to enable official YouTube collection." });
      const input = await readJson(req);
      const ids = Array.isArray(input.videos) ? input.videos.map((item) => typeof item === "string" ? youtubeVideoId(item.trim()) : null) : [];
      if (!ids.length || ids.length > 50 || ids.some((id) => !id)) return send(res, 400, { error: "Provide 1 to 50 valid YouTube video IDs or video URLs." });
      return send(res, 200, { videos: await youtubeVideos([...new Set(ids)]) });
    }
    if (req.method === "GET" && url.pathname === "/api/youtube/channel") {
      if (!process.env.YOUTUBE_API_KEY) return send(res, 503, { error: "Set YOUTUBE_API_KEY to enable official YouTube collection." });
      const channel = (url.searchParams.get("channel") ?? "").trim();
      if (!channel || channel.length > 100) return send(res, 400, { error: "Enter a channel ID or @handle up to 100 characters." });
      const limit = Math.min(250, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
      return send(res, 200, await youtubeChannel(channel, limit));
    }
    if (req.method === "GET" && url.pathname === "/api/github/search") {
      const query = (url.searchParams.get("q") ?? "").trim();
      const sort = url.searchParams.get("sort") ?? "stars";
      if (!query || query.length > 256) return send(res, 400, { error: "Enter a GitHub repository search up to 256 characters." });
      if (!["stars", "updated"].includes(sort)) return send(res, 400, { error: "Sort must be stars or updated." });
      return send(res, 200, { repositories: await githubSearch(query, sort) });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/github/repos/")) {
      const match = /^\/api\/github\/repos\/([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/.exec(url.pathname);
      if (!match) return send(res, 400, { error: "Enter a valid public owner/repository name." });
      return send(res, 200, await githubRepoDetails(match[1], match[2]));
    }
    if (req.method === "GET" && url.pathname === "/api/feeds/collect") {
      const feedUrl = (url.searchParams.get("url") ?? "").trim();
      if (!feedUrl || feedUrl.length > 2048) return send(res, 400, { error: "Enter an RSS or Atom feed URL up to 2048 characters." });
      return send(res, 200, await collectFeed(feedUrl));
    }
    if (req.method === "POST" && url.pathname === "/auth/disconnect") {
      const origin = req.headers.origin;
      if (!origin || new URL(origin).host !== req.headers.host) return send(res, 403, { error: "Same-origin request required." });
      const id = cookies(req)[sessionCookie];
      if (id) sessions.delete(id);
      return send(res, 200, { ok: true }, "application/json; charset=utf-8", { "set-cookie": cookieOptions("", 0) });
    }
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, await readFile(join(root, "index.html"), "utf8"), "text/html; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/app.js") return send(res, 200, await readFile(join(root, "app.js"), "utf8"), "text/javascript; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/styles.css") return send(res, 200, await readFile(join(root, "styles.css"), "utf8"), "text/css; charset=utf-8");
    return send(res, 404, { error: "Not found" });
  } catch (error) {
    return send(res, 500, { error: error instanceof Error ? error.message : "Unexpected server error" });
  }
});

server.listen(port, production ? "0.0.0.0" : "127.0.0.1", () => process.stdout.write(`REA Workbench listening on ${port}\n`));
