import { createHmac, timingSafeEqual } from "node:crypto";
import { setCors, handlePreflight } from "../lib/http.js";

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  setCors(res);

  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  try {
    const secret = process.env.SHORTLY_AGENT_AUTH_SECRET || "";
    if (!secret) {
      res.status(200).json({
        required: false,
        authenticated: true,
        user: null,
      });
      return;
    }

    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const token = String(body.token || "").trim();
    if (!token) {
      res.status(401).json({
        required: true,
        authenticated: false,
        error: "Missing Shortly access token.",
      });
      return;
    }

    const payload = verifyShortlyAgentToken(token, secret);
    if (!payload) {
      res.status(401).json({
        required: true,
        authenticated: false,
        error: "Invalid or expired Shortly access token.",
      });
      return;
    }

    res.status(200).json({
      required: true,
      authenticated: true,
      user: {
        loginId: payload.loginId || payload.id || null,
        agentId: payload.agentId || "pix-post-agent",
        username: payload.username || null,
        displayName: payload.displayName || payload.name || payload.username || "Shortly user",
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message || "Agent session check failed." });
  }
}

function verifyShortlyAgentToken(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 2) return null;

  const [payloadPart, signaturePart] = parts;
  const expected = base64UrlEncode(createHmac("sha256", secret).update(payloadPart).digest());
  if (!safeEqual(signaturePart, expected)) return null;

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && Number(payload.exp) < now) return null;
  if (payload.agentId && payload.agentId !== "pix-post-agent" && payload.agentId !== "pix") return null;
  return payload;
}

function base64UrlEncode(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
