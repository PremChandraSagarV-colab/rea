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
  throw new Error(`Unexpected mock request: ${url.href}`);
};

const { server } = await import("./server.mjs");
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
console.log("mock integration passed: Gmail search/body/attachment, YouTube search/video URL/channel uploads");
await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
