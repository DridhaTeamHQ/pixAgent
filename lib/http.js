// Shared HTTP utilities used by serverless functions.

export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

// CORS helper — Vercel functions are same-origin in production, but enabling
// permissive CORS keeps local dev (vercel dev) and tooling friction-free.
export function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Caption");
}

export function handlePreflight(req, res) {
  if (req.method === "OPTIONS") {
    setCors(res);
    res.status(204).end();
    return true;
  }
  return false;
}

// Read a raw request body into a Buffer (for endpoints that disable bodyParser).
export async function readRawBody(req, maxBytes = 10 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error(`Body exceeds ${maxBytes} bytes.`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
