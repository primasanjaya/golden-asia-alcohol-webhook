"""
Shopify Alcohol Order Enforcement — Webhook Handler

When a customer places an order with alcohol products but selects shipping
instead of local pickup, this webhook automatically cancels the order and
notifies the customer.

SETUP:
1. Install deps:  pip install flask requests
2. Set environment variables (or create a .env file):
     SHOPIFY_SHOP_DOMAIN=goldenasia.myshopify.com
     SHOPIFY_ACCESS_TOKEN=shpat_xxxxxxxxxxxx   (Admin API token)
     SHOPIFY_WEBHOOK_SECRET=your_webhook_secret
3. Run locally for testing:  python alcohol_webhook.py
4. Deploy to Render.com (free tier) or similar

SHOPIFY WEBHOOK REGISTRATION:
  Admin → Settings → Notifications → Webhooks
  → Add webhook: Order creation → your-app-url/webhook/orders-created
  → Format: JSON

HOW TO GET ADMIN API TOKEN:
  Admin → Settings → Apps → Develop apps → Create an app
  → Configure Admin API scopes: read_orders, write_orders, read_products
  → Install app → copy the Admin API access token
"""

import base64
import hashlib
import hmac
import json
import logging
import os

import requests
from flask import Flask, abort, request

app = Flask(__name__)
logging.basicConfig(level=logging.INFO)
log = logging.getLogger(__name__)

SHOP_DOMAIN = os.environ.get("SHOPIFY_SHOP_DOMAIN", "goldenasia.myshopify.com")
ACCESS_TOKEN = os.environ.get("SHOPIFY_ACCESS_TOKEN", "")
WEBHOOK_SECRET = os.environ.get("SHOPIFY_WEBHOOK_SECRET", "")
ALCOHOL_TAG = "alcohol"


def verify_webhook(data: bytes, hmac_header: str) -> bool:
    digest = hmac.new(WEBHOOK_SECRET.encode("utf-8"), data, hashlib.sha256).digest()
    computed = base64.b64encode(digest).decode("utf-8")
    return hmac.compare_digest(computed, hmac_header)


def shopify_get(endpoint: str) -> dict:
    url = f"https://{SHOP_DOMAIN}/admin/api/2024-01/{endpoint}"
    headers = {"X-Shopify-Access-Token": ACCESS_TOKEN, "Content-Type": "application/json"}
    r = requests.get(url, headers=headers, timeout=10)
    r.raise_for_status()
    return r.json()


def shopify_post(endpoint: str, payload: dict) -> dict:
    url = f"https://{SHOP_DOMAIN}/admin/api/2024-01/{endpoint}"
    headers = {"X-Shopify-Access-Token": ACCESS_TOKEN, "Content-Type": "application/json"}
    r = requests.post(url, headers=headers, json=payload, timeout=10)
    r.raise_for_status()
    return r.json()


def product_has_alcohol_tag(product_id: int) -> bool:
    try:
        data = shopify_get(f"products/{product_id}.json")
        tags = [t.strip().lower() for t in data["product"].get("tags", "").split(",")]
        return ALCOHOL_TAG in tags
    except Exception as e:
        log.error("Failed to fetch product %s: %s", product_id, e)
        return False


def is_local_pickup(order: dict) -> bool:
    """Returns True if the order's shipping method is local pickup."""
    shipping_lines = order.get("shipping_lines", [])
    if not shipping_lines:
        return True  # no shipping line = pickup / digital
    for line in shipping_lines:
        title = line.get("title", "").lower()
        code = line.get("code", "").lower()
        if "pickup" in title or "pickup" in code or "nouto" in title:
            return True
    return False


def cancel_order(order_id: int, order_number: str) -> None:
    log.info("Cancelling order %s (id %s) — alcohol + shipping", order_number, order_id)
    note = (
        "Tilaus peruutettu: ostoskorissa oli alkoholituotteita, jotka eivät voi tulla postissa. "
        "Tee uusi tilaus ja valitse nouto myymälästä. / "
        "Order cancelled: cart contained alcohol products which cannot be shipped. "
        "Please reorder and select local store pickup."
    )
    shopify_post(
        f"orders/{order_id}/cancel.json",
        {
            "reason": "other",
            "note": note,
            "email": True,  # sends cancellation email to customer
            "refund": True,
        },
    )
    log.info("Order %s cancelled and customer notified.", order_number)


@app.route("/webhook/orders-created", methods=["POST"])
def orders_created():
    raw = request.get_data()

    # Verify webhook authenticity
    if WEBHOOK_SECRET:
        hmac_header = request.headers.get("X-Shopify-Hmac-Sha256", "")
        if not verify_webhook(raw, hmac_header):
            log.warning("Webhook HMAC verification failed — ignoring")
            abort(401)

    order = json.loads(raw)
    order_id = order.get("id")
    order_number = order.get("order_number", order_id)

    # Check if any line item is an alcohol product
    has_alcohol = any(
        product_has_alcohol_tag(item["product_id"])
        for item in order.get("line_items", [])
        if item.get("product_id")
    )

    if not has_alcohol:
        return "ok", 200

    log.info("Order %s contains alcohol — checking delivery method", order_number)

    if not is_local_pickup(order):
        cancel_order(order_id, order_number)
    else:
        log.info("Order %s: alcohol + pickup — allowed.", order_number)

    return "ok", 200


@app.route("/health", methods=["GET"])
def health():
    return "ok", 200


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5001))
    app.run(host="0.0.0.0", port=port, debug=False)
