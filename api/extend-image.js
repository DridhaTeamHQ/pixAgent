import { extendImageRequest } from "../lib/image-extension.js";

export const config = { api: { bodyParser: false, responseLimit: "16mb" }, maxDuration: 300 };

export default async function handler(req, res) {
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed." }); return; }
  const result = await extendImageRequest(req, process.env.OPENAI_API_KEY);
  res.status(result.status).json(result.body);
}
