const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

export async function handler(event) {
  // Only allow GET
  if (event.httpMethod !== "GET") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  try {
    const params = event.queryStringParameters || {};
    const target = params.url;

    if (!target) {
      return { statusCode: 400, body: JSON.stringify({ error: "Image URL is required." }) };
    }

    const parsed = new URL(target);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return { statusCode: 400, body: JSON.stringify({ error: "Only http and https image URLs are supported." }) };
    }

    const response = await fetch(parsed, { headers: { "user-agent": USER_AGENT } });
    if (!response.ok) {
      return { statusCode: 502, body: JSON.stringify({ error: `Image source returned ${response.status}.` }) };
    }

    const contentType = response.headers.get("content-type") || "application/octet-stream";
    const buffer = Buffer.from(await response.arrayBuffer());

    return {
      statusCode: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400",
        "Access-Control-Allow-Origin": "*"
      },
      body: buffer.toString("base64"),
      isBase64Encoded: true
    };
  } catch (error) {
    return { statusCode: 500, body: JSON.stringify({ error: error.message || "Image proxy failed." }) };
  }
}
