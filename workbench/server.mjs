import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 3000);
const production = process.env.NODE_ENV === "production";
const sessions = new Map();
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
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:; connect-src 'self'", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
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
    return { id: message.id, from: headers.from ?? "", to: headers.to ?? "", subject: headers.subject ?? "(no subject)", date: headers.date ?? "", snippet: message.snippet ?? "" };
  }));
}

const server = createServer(async (req, res) => {
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
      return send(res, 200, { gmailConfigured: Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI), gmailConnected: Boolean(session.refreshToken || (session.accessToken && session.tokenExpiresAt > Date.now())) }, "application/json; charset=utf-8", { "set-cookie": cookieOptions(id, 86_400) });
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
