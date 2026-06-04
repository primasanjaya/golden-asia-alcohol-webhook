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
  return lines.some((l) => {
    const t = (l.title ?? "").toLowerCase();
    const c = (l.code ?? "").toLowerCase();
    return t.includes("pickup") || c.includes("pickup") || t.includes("nouto");
  });
}

async function refundAlcoholItems(order, alcoholLineItemIds) {
  const orderId = order.id;
  const orderNumber = order.order_number ?? orderId;

  // Build refund line items for alcohol only, with restock
  const refundLineItems = order.line_items
    .filter((item) => alcoholLineItemIds.includes(item.id))
    .map((item) => ({
      line_item_id: item.id,
      quantity: item.quantity,
      restock_type: "return",        // restores inventory
      location_id: item.location_id, // required for restock
    }));

  log(`Refunding ${refundLineItems.length} alcohol item(s) from order ${orderNumber}`);

  // Calculate refund amount for alcohol items only
  const refundAmount = order.line_items
    .filter((item) => alcoholLineItemIds.includes(item.id))
    .reduce((sum, item) => sum + parseFloat(item.price) * item.quantity, 0)
    .toFixed(2);

  const note =
    "⚠️ ALKOHOLITUOTTEET POISTETTU TILAUKSESTA / ALCOHOL ITEMS REMOVED ⚠️\n\n" +
    "Alkoholituotteitasi ei voida toimittaa — ne on noudettava myymälästä henkilökohtaisesti lain mukaan. " +
    "Muut tuotteesi käsitellään normaalisti.\n\n" +
    "👉 Noutaaksesi alkoholituotteet: Suurpellon puistokatu 14 L3, Espoo\n" +
    "Tai tee uusi tilaus osoitteessa goldenasia.fi ja valitse NOUTO MYYMÄLÄSTÄ.\n\n" +
    "---\n\n" +
    "Your alcohol items have been removed from this order — by law, alcohol cannot be delivered and must be picked up in person. " +
    "Your other items will be processed normally.\n\n" +
    "👉 To pick up your alcohol: Suurpellon puistokatu 14 L3, Espoo\n" +
    "Or reorder at goldenasia.fi and select LOCAL STORE PICKUP.\n\n" +
    "Sorry for the inconvenience! / Pahoittelemme häiriötä!";

  await shopifyPost(`orders/${orderId}/refunds.json`, {
    refund: {
      notify: true,
      note,
      shipping: { full_refund: false },
      refund_line_items: refundLineItems,
      transactions: [
        {
          parent_id: order.payment_gateway_names?.[0],
          amount: refundAmount,
          kind: "refund",
          gateway: order.payment_gateway_names?.[0] ?? "manual",
        },
      ],
    },
  });

  log(`Order ${orderNumber}: alcohol items refunded and stock restored.`);
}

function log(msg) {
  console.log(msg);
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

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks);

  const hmacHeader = req.headers["x-shopify-hmac-sha256"] ?? "";
  if (WEBHOOK_SECRET && !verifyWebhook(rawBody, hmacHeader)) {
    console.warn("HMAC verification failed");
    return res.status(401).send("Unauthorized");
  }

  const order = JSON.parse(rawBody.toString());
  const orderId = order.id;
  const orderNumber = order.order_number ?? orderId;

  if (isLocalPickup(order)) {
    log(`Order ${orderNumber}: local pickup — allowed.`);
    return res.status(200).send("ok");
  }

  // Find which line items are alcohol
  const alcoholItemIds = (
    await Promise.all(
      (order.line_items ?? [])
        .filter((item) => item.product_id)
        .map(async (item) => {
          const isAlcohol = await productHasAlcoholTag(item.product_id);
          return isAlcohol ? item.id : null;
        })
    )
  ).filter(Boolean);

  if (alcoholItemIds.length === 0) {
    log(`Order ${orderNumber}: no alcohol — allowed.`);
    return res.status(200).send("ok");
  }

  log(`Order ${orderNumber}: ${alcoholItemIds.length} alcohol item(s) with non-pickup delivery — refunding`);
  await refundAlcoholItems(order, alcoholItemIds);

  return res.status(200).send("ok");
}
