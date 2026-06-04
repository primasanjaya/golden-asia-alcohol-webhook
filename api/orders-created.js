import crypto from "crypto";

const SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN;
const ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;
const ALCOHOL_TAG = "alcohol";

async function shopifyGet(endpoint) {
  const res = await fetch(
    `https://${SHOP_DOMAIN}/admin/api/2024-01/${endpoint}`,
    { headers: { "X-Shopify-Access-Token": ACCESS_TOKEN } }
  );
  if (!res.ok) throw new Error(`Shopify GET ${endpoint} failed: ${res.status}`);
  return res.json();
}

async function shopifyPost(endpoint, body) {
  const res = await fetch(
    `https://${SHOP_DOMAIN}/admin/api/2024-01/${endpoint}`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": ACCESS_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) throw new Error(`Shopify POST ${endpoint} failed: ${res.status}`);
  return res.json();
}

async function productHasAlcoholTag(productId) {
  try {
    const data = await shopifyGet(`products/${productId}.json`);
    const tags = data.product.tags.split(",").map((t) => t.trim().toLowerCase());
    return tags.includes(ALCOHOL_TAG);
  } catch {
    return false;
  }
}

function isLocalPickup(order) {
  const lines = order.shipping_lines ?? [];
  if (lines.length === 0) return true; // no shipping = pickup
  return lines.some((l) => {
    const t = (l.title ?? "").toLowerCase();
    const c = (l.code ?? "").toLowerCase();
    return t.includes("pickup") || c.includes("pickup") || t.includes("nouto");
  });
}

async function cancelOrder(orderId, orderNumber) {
  console.log(`Cancelling order ${orderNumber} — alcohol + shipping`);
  await shopifyPost(`orders/${orderId}/cancel.json`, {
    reason: "other",
    note:
      "Tilaus peruutettu: alkoholituotteita ei voi toimittaa postissa. " +
      "Tee uusi tilaus ja valitse nouto myymälästä. / " +
      "Order cancelled: alcohol cannot be shipped. " +
      "Please reorder and select local store pickup.",
    email: true,
    refund: true,
  });
  console.log(`Order ${orderNumber} cancelled and customer notified.`);
}

function verifyWebhook(rawBody, hmacHeader) {
  const digest = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(rawBody)
    .digest("base64");
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  // Read raw body for HMAC verification
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks);

  // Verify webhook signature
  const hmacHeader = req.headers["x-shopify-hmac-sha256"] ?? "";
  if (WEBHOOK_SECRET && !verifyWebhook(rawBody, hmacHeader)) {
    console.warn("HMAC verification failed");
    return res.status(401).send("Unauthorized");
  }

  const order = JSON.parse(rawBody.toString());
  const orderId = order.id;
  const orderNumber = order.order_number ?? orderId;

  // Check if any line item is an alcohol product
  const alcoholChecks = await Promise.all(
    (order.line_items ?? [])
      .filter((item) => item.product_id)
      .map((item) => productHasAlcoholTag(item.product_id))
  );
  const hasAlcohol = alcoholChecks.some(Boolean);

  if (!hasAlcohol) return res.status(200).send("ok");

  console.log(`Order ${orderNumber} has alcohol — checking delivery method`);

  if (!isLocalPickup(order)) {
    await cancelOrder(orderId, orderNumber);
  } else {
    console.log(`Order ${orderNumber}: alcohol + pickup — allowed.`);
  }

  return res.status(200).send("ok");
}
