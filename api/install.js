// One-time OAuth install — visit /api/install?shop=goldenasia-2.myshopify.com
export default function handler(req, res) {
  const shop = req.query.shop || process.env.SHOPIFY_SHOP_DOMAIN;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const redirectUri = `https://${req.headers.host}/api/callback`;
  const scopes = "read_products,read_orders,write_orders";
  const state = Math.random().toString(36).substring(2);

  const authUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${clientId}` +
    `&scope=${scopes}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&state=${state}`;

  res.redirect(authUrl);
}
