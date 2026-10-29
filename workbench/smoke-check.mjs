import assert from "node:assert/strict";

process.env.PORT = "0";
process.env.GOOGLE_CLIENT_ID = "client-id";
process.env.GOOGLE_CLIENT_SECRET = "client-secret";
process.env.GOOGLE_REDIRECT_URI = "http://localhost:3098/auth/google/callback";
process.env.YOUTUBE_API_KEY = "test-key";
const nativeFetch = globalThis.fetch;
const apiVideo = (id) => ({ id, snippet: { title: `Video ${id}`, description: "Public video description", channelTitle: "Example Channel", publishedAt: "2025-01-01T00:00:00Z", thumbnails: { default: { url: "https://i.ytimg.com/vi/test/default.jpg" } } }, contentDetails: { duration: "PT1M", caption: "true" }, statistics: { viewCount: "42", likeCount: "3" } });
globalThis.fetch = async (input, init) => {
  const url = new URL(input);
  if (url.hostname === "127.0.0.1") return nativeFetch(input, init);
  if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 });
  if (url.hostname === "gmail.googleapis.com") {
    if (url.pathname.endsWith("/messages")) return Response.json({ messages: [{ id: "m1" }] });
    if (url.pathname.endsWith("/attachments/att1")) return Response.json({ data: Buffer.from("attachment-payload").toString("base64url") });
    const full = url.searchParams.get("format") === "full";
    const payload = full
      ? { headers: [{ name: "Subject", value: "Invoice" }, { name: "From", value: "sender@example.com" }], mimeType: "multipart/mixed", parts: [{ partId: "1", mimeType: "text/plain", body: { data: Buffer.from("Message body from fixture").toString("base64url") } }, { partId: "1.2", filename: "receipt.txt", mimeType: "text/plain", body: { attachmentId: "att1", size: 18 } }] }
      : { headers: [{ name: "Subject", value: "Invoice" }, { name: "From", value: "sender@example.com" }] };
    return Response.json({ id: "m1", snippet: "Invoice preview", payload });
  }
  if (url.hostname === "www.googleapis.com") {
    if (url.pathname.endsWith("/search")) return Response.json({ items: [{ id: { videoId: "abcdefghijk" } }] });
    if (url.pathname.endsWith("/channels")) return Response.json({ items: [{ id: "UC1234567890123456789012", snippet: { title: "Example Channel", description: "Channel fixture" }, contentDetails: { relatedPlaylists: { uploads: "uploads" } }, statistics: { subscriberCount: "9", viewCount: "900", videoCount: "2" } }] });
    if (url.pathname.endsWith("/playlistItems")) return Response.json({ items: [{ contentDetails: { videoId: "abcdefghijk" } }, { contentDetails: { videoId: "lmnopqrstuv" } }] });
    if (url.pathname.endsWith("/videos")) return Response.json({ items: url.searchParams.get("id").split(",").map(apiVideo) });
  }
  if (url.hostname === "api.github.com") {
    if (url.pathname === "/search/repositories") return Response.json({ items: [{ full_name: "sample/project", description: "Test project", html_url: "https://github.com/sample/project", stargazers_count: 12, forks_count: 2, open_issues_count: 1, language: "TypeScript", license: { spdx_id: "MIT" }, updated_at: "2025-01-01T00:00:00Z", default_branch: "main" }] });
    if (url.pathname.endsWith("/releases")) return Response.json([{ tag_name: "v1.0.0", name: "1.0", published_at: "2025-01-01T00:00:00Z", html_url: "https://github.com/sample/project/releases/tag/v1.0.0", prerelease: false }]);
    if (url.pathname.endsWith("/issues")) return Response.json([{ number: 7, title: "Improve docs", updated_at: "2025-01-01T00:00:00Z", html_url: "https://github.com/sample/project/issues/7", labels: [{ name: "docs" }] }]);
  }
  throw new Error(`Unexpected mock request: ${url.href}`);
};

const { server, parseFeedDocument } = await import("./server.mjs");
await new Promise((resolve) => setTimeout(resolve, 100));
const origin = `http://127.0.0.1:${server.address().port}`;
let response = await fetch(`${origin}/api/status`);
const cookie = response.headers.get("set-cookie").split(";", 1)[0];
response = await fetch(`${origin}/auth/google`, { headers: { cookie }, redirect: "manual" });
const state = new URL(response.headers.get("location")).searchParams.get("state");
await fetch(`${origin}/auth/google/callback?code=mock&state=${state}`, { headers: { cookie }, redirect: "manual" });
response = await fetch(`${origin}/api/gmail/search?q=invoice`, { headers: { cookie } });
const mail = await response.json(); assert.equal(mail.messages[0].subject, "Invoice");
response = await fetch(`${origin}/api/gmail/messages/m1`, { headers: { cookie } });
const message = await response.json(); assert.equal(message.body, "Message body from fixture"); assert.equal(message.attachments[0].filename, "receipt.txt");
response = await fetch(`${origin}/api/gmail/messages/m1/attachments/1.2`, { headers: { cookie } });
assert.equal(await response.text(), "attachment-payload");
response = await fetch(`${origin}/api/youtube/search?q=agents`); assert.equal((await response.json()).videos[0].id, "abcdefghijk");
response = await fetch(`${origin}/api/youtube/videos`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ videos: ["https://youtu.be/abcdefghijk"] }) });
assert.equal((await response.json()).videos[0].title, "Video abcdefghijk");
response = await fetch(`${origin}/api/youtube/channel?channel=%40sample&limit=2`);
const channel = await response.json(); assert.equal(channel.videos.length, 2); assert.equal(channel.channel.title, "Example Channel");
response = await fetch(`${origin}/api/chrome/targets?endpoint=https%3A%2F%2Fexample.com`); assert.equal(response.status, 400);
response = await fetch(`${origin}/api/github/search?q=agents`); assert.equal((await response.json()).repositories[0].name, "sample/project");
response = await fetch(`${origin}/api/github/repos/sample/project`); assert.equal((await response.json()).issues[0].number, 7);
const rss = parseFeedDocument(Buffer.from(`<rss><channel><title>Example Blog</title><link>https://example.com/</link><item><title>First Post</title><link>/first</link><pubDate>Mon, 01 Jan 2025 00:00:00 GMT</pubDate><description>&lt;b&gt;First summary&lt;/b&gt;</description></item></channel></rss>`), "https://example.com/feed.xml");
assert.equal(rss.title, "Example Blog"); assert.equal(rss.entries[0].url, "https://example.com/first"); assert.equal(rss.entries[0].summary, "First summary");
const atom = parseFeedDocument(Buffer.from(`<feed xmlns="http://www.w3.org/2005/Atom"><title>Example Atom</title><entry><title>Atom Post</title><link href="/atom"/><updated>2025-01-02T00:00:00Z</updated><summary>Atom summary</summary></entry></feed>`), "https://example.com/atom.xml");
assert.equal(atom.title, "Example Atom"); assert.equal(atom.entries[0].url, "https://example.com/atom");
console.log("mock integration passed: Gmail search/body/attachment, YouTube search/video URL/channel uploads, GitHub repo/release/issue browsing, RSS/Atom parsing, Chrome loopback guard");
await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
