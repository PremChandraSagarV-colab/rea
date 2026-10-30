process.env.LOCAL_AGENT_ENABLED = "true";
process.env.NODE_ENV = "development";
await import("./server.mjs");
