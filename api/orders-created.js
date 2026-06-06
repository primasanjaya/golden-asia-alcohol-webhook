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
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Shopify POST ${endpoint} failed: ${res.status} — ${errText}`);
  }
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

async function cancelOrder(orderId, orderNumber) {
  console.log(`Cancelling original order ${orderNumber}`);
  await shopifyPost(`orders/${orderId}/cancel.json`, {
    reason: "other",
    email: true, // notify customer of cancellation
    restock: true,
    note:
      "⚠️ Tilaus peruutettu / Order cancelled\n\n" +
      "Tilauksesi sisälsi alkoholituotteita, joita ei lain mukaan voi toimittaa kotiin. " +
      "Olemme luoneet sinulle uuden tilauksen noutoa varten ja lähetämme laskun pian.\n\n" +
      "📍 Nouto: Suurpellon puistokatu 14 L3, Espoo\n" +
      "📞 +358 40 360 6359\n\n" +
      "---\n\n" +
      "Your order contained alcohol which cannot be delivered by law. " +
      "We have created a new pickup order for you and will send an invoice shortly.\n\n" +
      "📍 Pickup: Suurpellon puistokatu 14 L3, Espoo\n" +
      "📞 +358 40 360 6359",
  });
  console.log(`Order ${orderNumber} cancelled, stock restocked, customer notified.`);
}

async function createPickupDraftOrder(order, alcoholItemIds) {
  const orderNumber = order.order_number ?? order.id;
  const customer = order.customer;

  // Build line items — all items (alcohol + non-alcohol), since they all go into the new pickup order
  const lineItems = order.line_items.map((item) => ({
    variant_id: item.variant_id,
    quantity: item.quantity,
    price: item.price,
    title: item.title,
  }));

  const customMessage =
    "⚠️ Tilauksesi on muutettu / Your order has been updated ⚠️\n\n" +
    "Alkuperäinen tilauksesi sisälsi alkoholituotteita, joita ei lain mukaan voida toimittaa kotiin. " +
    "Olemme peruuttaneet alkuperäisen tilauksesi ja luoneet uuden tilauksen noutoa varten. " +
    "Maksa alla olevan laskun mukaan ja ota meihin yhteyttä noutajan sopimiseksi.\n\n" +
    "📍 Nouto: Suurpellon puistokatu 14 L3, Espoo\n" +
    "📞 +358 40 360 6359 (Puhelin / SMS / WhatsApp)\n\n" +
    "---\n\n" +
    "Your original order contained alcohol which cannot be delivered by law. " +
    "We have cancelled the original order and created this new pickup order for all your items. " +
    "Please pay the invoice below and contact us to arrange pickup.\n\n" +
    "📍 Pickup: Suurpellon puistokatu 14 L3, Espoo\n" +
    "📞 +358 40 360 6359 (Phone / SMS / WhatsApp)";

  const draftOrderPayload = {
    draft_order: {
      line_items: lineItems,
      customer: customer ? { id: customer.id } : undefined,
      shipping_address: order.shipping_address,
      billing_address: order.billing_address,
      email: order.email,
      // Local pickup — zero-cost shipping line
      shipping_line: {
        title: "Local Pickup",
        price: "0.00",
        custom: true,
      },
      note: `Recreated from order ${orderNumber} — alcohol pickup enforcement`,
      note_attributes: [
        { name: "original_order", value: String(orderNumber) },
        { name: "reason", value: "alcohol_pickup_required" },
      ],
      tags: "alcohol-pickup-required",
    },
  };

  console.log(`Creating draft pickup order for customer from order ${orderNumber}`);
  const result = await shopifyPost("draft_orders.json", draftOrderPayload);
  const draftOrder = result.draft_order;

  if (!draftOrder) {
    console.error("Failed to create draft order:", JSON.stringify(result));
    return;
  }

  console.log(`Draft order ${draftOrder.name} created. Waiting for calculation...`);
  await new Promise((resolve) => setTimeout(resolve, 25000)); // wait 25 seconds

  console.log(`Sending invoice to ${order.email}`);
  try {
  await shopifyPost(`draft_orders/${draftOrder.id}/send_invoice.json`, {
    draft_order_invoice: {
      custom_message:
        "Hei! Olemme luoneet uuden tilauksen noutoa varten. Katso lasku alta ja ota meihin yhteyttä noutajan sopimiseksi.\n\n" +
        "Hi! We have created a new pickup order for you. Please see the invoice below and contact us to arrange pickup.\n\n" +
        "Suurpellon puistokatu 14 L3, Espoo\n" +
        "+358 40 360 6359 (Phone / SMS / WhatsApp)",
    },
  });
  console.log(`Invoice sent to ${order.email} for draft order ${draftOrder.name}`);
  } catch (err) {
    console.error(`Failed to send invoice for draft order ${draftOrder.name}:`, err.message);
  }
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
    console.log(`Order ${orderNumber}: local pickup — allowed.`);
    return res.status(200).send("ok");
  }

  // Check if any line item is alcohol
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
    console.log(`Order ${orderNumber}: no alcohol — allowed.`);
    return res.status(200).send("ok");
  }

  console.log(`Order ${orderNumber}: alcohol + non-pickup — cancelling and creating pickup draft order`);

  try {
    await cancelOrder(orderId, orderNumber);
    await createPickupDraftOrder(order, alcoholItemIds);
  } catch (err) {
    console.error(`Error processing order ${orderNumber}:`, err.message);
  }

  return res.status(200).send("ok");
}
