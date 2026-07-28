import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PORT = parseInt(process.env.PORT || "80", 10);
const REDMINE_URL = process.env.REDMINE_URL || "https://pm.mieweb.com/";
const REDMINE_API_KEY = process.env.REDMINE_API_KEY || "";

if (!REDMINE_API_KEY) {
  console.error("ERROR: REDMINE_API_KEY environment variable is required");
  process.exit(1);
}

// Store active sessions: sessionId -> { transport, stdioTransport, subprocess }
const sessions = new Map();

const app = express();
app.use(express.json());

// Health check
app.get("/health", (req, res) => {
  const users = [...sessions.values()].map((s) => s.user).filter(Boolean);
  res.json({ status: "ok", sessions: sessions.size, users });
});

// Resolve user identity from request headers or query params.
// Priority: x-redmine-user > x-ozwell-user-email > x-ozwell-user-name > ?user= > Basic auth
function resolveUser(req) {
  // 1. Explicit x-redmine-user header
  const headerUser = req.headers["x-redmine-user"];
  if (headerUser) return headerUser.trim();

  // 2. Ozwell AI headers (sent automatically by the AI platform)
  const ozwellEmail = req.headers["x-ozwell-user-email"];
  if (ozwellEmail) return ozwellEmail.trim();

  const ozwellName = req.headers["x-ozwell-user-name"];
  if (ozwellName) return ozwellName.trim();

  // 3. Query parameter
  const queryUser = req.query.user;
  if (queryUser) return queryUser.trim();

  // 4. Basic auth username (if the AI proxy sends credentials)
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Basic ")) {
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString();
    const username = decoded.split(":")[0];
    if (username) return username.trim();
  }

  return null;
}

// MCP endpoint
app.all("/mcp", async (req, res) => {
  // Check for existing session
  const sessionId = req.headers["mcp-session-id"];

  if (sessionId && sessions.has(sessionId)) {
    // Existing session - forward to its transport
    const session = sessions.get(sessionId);
    await session.transport.handleRequest(req, res, req.body);
    return;
  }

  if (sessionId && !sessions.has(sessionId)) {
    // Invalid session
    res.status(404).json({ error: "Session not found" });
    return;
  }

  // Resolve the logged-in user identity from the request
  const onBehalfOf = resolveUser(req);
  if (!onBehalfOf) {
    res.status(401).json({
      error: "User identity required. Provide via x-redmine-user header, ?user= query param, or Basic auth.",
    });
    return;
  }

  console.log(`New connection for user: ${onBehalfOf}`);

  // New session - spawn a new redmine-mcp subprocess and create transport
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });

  // Spawn the redmine-mcp subprocess, locked to this user's identity.
  // REDMINE_ON_BEHALF_OF = the user login/email
  // REDMINE_LOCK_ON_BEHALF_OF = 1 (prevents AI from overriding via prompt injection)
  const stdioTransport = new StdioClientTransport({
    command: "/home/pralambomanarivo/redmine-mcp-rs/target/release/redmine-mcp-rs",
    args: [],
    env: {
      ...process.env,
      REDMINE_URL,
      REDMINE_API_KEY,
      REDMINE_ON_BEHALF_OF: onBehalfOf,
      REDMINE_LOCK_ON_BEHALF_OF: "1",
    },
  });

  // Bridge: forward messages from HTTP client to stdio subprocess
  transport.onmessage = async (message) => {
    try {
      await stdioTransport.send(message);
    } catch (err) {
      console.error("Error forwarding to stdio:", err);
    }
  };

  // Bridge: forward messages from stdio subprocess to HTTP client
  stdioTransport.onmessage = async (message) => {
    try {
      await transport.send(message);
    } catch (err) {
      console.error("Error forwarding to HTTP:", err);
    }
  };

  // Handle transport close
  transport.onclose = () => {
    const sid = transport.sessionId;
    console.log(`Session ${sid} closed`);
    stdioTransport.close().catch(() => {});
    sessions.delete(sid);
  };

  stdioTransport.onclose = () => {
    const sid = transport.sessionId;
    console.log(`Stdio transport closed for session ${sid}`);
    transport.close().catch(() => {});
    sessions.delete(sid);
  };

  transport.onerror = (err) => {
    console.error("HTTP transport error:", err);
  };

  stdioTransport.onerror = (err) => {
    console.error("Stdio transport error:", err);
  };

  // Start the stdio connection
  try {
    await stdioTransport.start();
  } catch (err) {
    console.error("Failed to start stdio transport:", err);
    res.status(500).json({ error: "Failed to start MCP subprocess" });
    return;
  }

  // Handle the initial request
  await transport.handleRequest(req, res, req.body);

  // Store session after handling (sessionId is set after first request)
  if (transport.sessionId) {
    sessions.set(transport.sessionId, { transport, stdioTransport, user: onBehalfOf });
    console.log(`New session created: ${transport.sessionId} (user: ${onBehalfOf})`);
  }
});

// Handle DELETE for session termination
app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];
  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId);
    await session.transport.handleRequest(req, res, req.body);
    sessions.delete(sessionId);
  } else {
    res.status(404).json({ error: "Session not found" });
  }
});

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(`Redmine MCP Streamable HTTP proxy running on http://0.0.0.0:${PORT}/mcp`);
  console.log(`Proxying to redmine-mcp-rs (Rust) with REDMINE_URL=${REDMINE_URL}`);
});

server.on("error", (err) => {
  console.error("Server error:", err);
  process.exit(1);
});

// Keep process alive
process.on("SIGTERM", () => {
  console.log("Received SIGTERM, shutting down...");
  server.close();
  process.exit(0);
});
