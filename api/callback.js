// OAuth callback — Shopify redirects here after install
// Copy the access_token from the page and save it to Vercel env vars
export default async function handler(req, res) {
  const { code, shop } = req.query;

  if (!code || !shop) {
    return res.status(400).send("Missing code or shop");
  }

  const response = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_WEBHOOK_SECRET,
      code,
    }),
  });

  const data = await response.json();

  if (data.access_token) {
    // Display token — copy this into Vercel env vars as SHOPIFY_ACCESS_TOKEN
    res.status(200).send(`
      <h2>✅ App installed successfully!</h2>
      <p>Copy this token and save it in Vercel as <strong>SHOPIFY_ACCESS_TOKEN</strong>:</p>
      <code style="font-size:16px;background:#eee;padding:10px;display:block;word-break:break-all">
        ${data.access_token}
      </code>
      <p>Then add it to Vercel: Project → Settings → Environment Variables → SHOPIFY_ACCESS_TOKEN</p>
      <p><strong>Do not share this token with anyone.</strong></p>
    `);
  } else {
    res.status(400).send(`Error: ${JSON.stringify(data)}`);
  }
}
