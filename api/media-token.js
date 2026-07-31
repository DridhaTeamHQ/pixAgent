// Mints a short-lived token that lets the BROWSER talk to the Railway media
// service directly.
//
// Why not proxy the media calls through here, like /api/upscale-image does?
// Two hard limits:
//   * Vercel caps serverless request bodies at 4.5 MB. A local video upload
//     is routinely 20-200 MB, so it can never transit a Vercel function.
//   * A download + transcode runs for minutes, past what a function should
//     hold a connection open for.
// So the browser POSTs straight to the media service. To avoid shipping
// MEDIA_SECRET to the client, this endpoint signs a timestamp with it; the
// service verifies the HMAC and the expiry. The secret itself never leaves
// the server, and a leaked token is useless within a few minutes.

import crypto from "node:crypto";
import { setCors, handlePreflight } from "../lib/http.js";

const TOKEN_TTL_SECONDS = 15 * 60;   // long enough for a slow upload to finish

export function mintMediaToken(secret, ttlSeconds = TOKEN_TTL_SECONDS) {
  const expiry = String(Math.floor(Date.now() / 1000) + ttlSeconds);
  const sig = crypto.createHmac("sha256", secret).update(expiry).digest("hex");
  return `${expiry}.${sig}`;
}

export default async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  setCors(res);

  if (req.method !== "POST" && req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed." });
    return;
  }

  const base = (process.env.MEDIA_URL || "").replace(/\/+$/, "");
  if (!base) {
    res.status(503).json({ error: "Video is not configured on this deployment (MEDIA_URL unset)." });
    return;
  }

  const secret = process.env.MEDIA_SECRET || "";
  // No secret configured = the service is running open (local dev). Hand back
  // the URL with an empty token rather than failing.
  const token = secret ? mintMediaToken(secret) : "";

  res.status(200).json({ mediaUrl: base, token, expiresIn: TOKEN_TTL_SECONDS });
}
