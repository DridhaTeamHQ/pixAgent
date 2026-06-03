import { createHmac, timingSafeEqual } from "node:crypto";

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return json(204, {});
  }
  if (event.httpMethod !== "POST") {
    return json(405, { error: "Method not allowed." });
  }

  try {
    const secret = process.env.SHORTLY_AGENT_AUTH_SECRET || "";
    if (!secret) {
      return json(200, {
        required: false,
        authenticated: true,
        user: null,
      });
    }

    const body = JSON.parse(event.body || "{}");
    const token = String(body.token || "").trim();
    if (!token) {
      return json(401, {
        required: true,
        authenticated: false,
        error: "Missing Shortly access token.",
      });
    }

    const payload = verifyShortlyAgentToken(token, secret);
    if (!payload) {
      return json(401, {
        required: true,
        authenticated: false,
        error: "Invalid or expired Shortly access token.",
      });
    }

    return json(200, {
      required: true,
      authenticated: true,
      user: {
        loginId: payload.loginId || payload.id || null,
        agentId: payload.agentId || "pix-post-agent",
        username: payload.username || null,
        displayName: payload.displayName || payload.name || payload.username || "Shortly user",
      },
    });
  } catch (error) {
    return json(500, { error: error.message || "Agent session check failed." });
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

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body: statusCode === 204 ? "" : JSON.stringify(payload),
  };
}
