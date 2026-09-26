// Enforces the free-gift rule AFTER every discount is applied. Shopify checks
// a BXGY minimum before discount codes, so a rewards code can drag the real
// spend under the minimum with the gift still attached.
//
// Spend maths: gross merchandise subtotal minus each distinct discount
// application's totalAllocatedAmount (Shopify's own cart-wide figure). Never
// sum per-line allocations: when Shopify splits one variant into several
// lines it repeats the group's allocations on every split line, which
// double-counts the discount (live false block, 10 Sep 2026: two $65 lines
// each carrying 19.50 + 19.50 for a $39 discount, paid computed $256.40
// instead of $295.40). Per-line sums remain only as a fallback when no
// application carries totalAllocatedAmount.
//
// Config lives in the SHOP metafield custom.gwp_guard (JSON) so a GWP change
// is a metafield edit, never a redeploy. Two shapes, both supported:
//
// Single GWP (flat):
//   { "minimum_spend": 295, "gift_product_ids": [] }
//     gift_product_ids [] = generic: any product made 100% free by a
//     product-scoped discount counts as the gift.
//
// Tiered GWPs:
//   { "tiers": [
//       { "minimum_spend": 295, "gift_product_ids": ["gid://shopify/Product/A"] },
//       { "minimum_spend": 450, "gift_product_ids": ["gid://shopify/Product/B"] }
//   ] }
//     Each gift in the cart is held to ITS OWN tier's floor; the checkout must
//     cover the highest floor among the gifts present. Pinned tiers match
//     first; a tier with empty gift_product_ids acts as the catch-all.
//
// Optional top-level keys: "message" overrides the customer-facing error;
// "currency" (ISO code) limits enforcement to carts in that currency.
// Fail-open by design: a missing/malformed metafield means the guard is OFF,
// a gift product matching no tier is not enforced, and minimum_spend 0
// disables a tier. Misconfiguration can never block a legitimate checkout.

const DEFAULTS = {
  // OFF until the shop metafield is set: a freshly deployed guard must never
  // enforce a threshold nobody chose.
  tiers: [],
  currency: null, // null = enforce in every presentment currency
  message: null,
};

const EPSILON = 0.005;

/**
 * @param {import("../generated/api").CartValidationsGenerateRunInput} input
 * @returns {import("../generated/api").CartValidationsGenerateRunResult}
 */
export function cartValidationsGenerateRun(input) {
  // Enforce at CHECKOUT only, never during cart edits. Enforcing on
  // CART_INTERACTION plus an automatic BXGY that re-applies to a remaining
  // same-product line can make EVERY removal illegal and deadlock the cart
  // (live incident, 7 Sep 2026). Codes are entered at checkout, so
  // checkout-stage enforcement loses nothing. Unknown/missing step fails open.
  const step = input?.buyerJourney?.step;
  if (step !== "CHECKOUT_INTERACTION" && step !== "CHECKOUT_COMPLETION") {
    return { operations: [] };
  }

  const config = readConfig(input);
  const tiers = config.tiers.filter((tier) => tier.minimumSpend > 0);
  if (tiers.length === 0) {
    return { operations: [] };
  }

  const lines = input?.cart?.lines ?? [];
  if (lines.length === 0) {
    return { operations: [] };
  }

  // Thresholds are figures in one currency. When config.currency is set,
  // carts presented in any other currency are left alone (fail-open).
  const currency = input?.cart?.cost?.subtotalAmount?.currencyCode;
  if (config.currency && currency && currency !== config.currency) {
    return { operations: [] };
  }

  let grossSubtotal = 0;
  let perLinePaid = 0;
  let requiredSpend = 0;
  const applicationTotals = new Map();
  let sawApplicationTotal = false;

  for (const line of lines) {
    const subtotal = toNumber(line?.cost?.subtotalAmount?.amount);
    const unitPrice = toNumber(line?.cost?.amountPerQuantity?.amount);
    const allocations = line?.discountAllocations ?? [];
    grossSubtotal += subtotal;

    let allocatedTotal = 0;
    let productScopedTotal = 0;
    let hasFullPercentProductDiscount = false;

    for (const allocation of allocations) {
      const amount = toNumber(allocation?.discountedAmount?.amount);
      allocatedTotal += amount;

      const application = allocation?.discountApplication;
      if (application == null) {
        continue;
      }

      // Shipping discounts never touch product spend.
      if (application.targetType === "SHIPPING_LINE") {
        continue;
      }

      const total = application.totalAllocatedAmount?.amount;
      if (total != null && total !== "") {
        sawApplicationTotal = true;
        applicationTotals.set(applicationKey(application), toNumber(total));
      }

      // targetSelection ALL = order-scoped (rewards codes); anything else is a
      // product-scoped discount, the only kind that makes a gift.
      if (application.targetSelection === "ALL") {
        continue;
      }

      productScopedTotal += amount;

      // Shopify stamps the BXGY application onto every line, with a $0.00
      // allocation on the lines it did not discount. Only an allocation that
      // actually zeroed at least one unit is evidence of a gift.
      const coversOneUnit =
        amount > 0 && amount >= Math.min(unitPrice > 0 ? unitPrice : subtotal, subtotal) - EPSILON;
      if (
        coversOneUnit &&
        application.value?.__typename === "PricingPercentageValue" &&
        toNumber(application.value.value) >= 99.999
      ) {
        hasFullPercentProductDiscount = true;
      }
    }

    perLinePaid += Math.max(0, subtotal - allocatedTotal);

    // A gift line is one a product-scoped discount made free: the whole line
    // nets to $0, or (gift quantity bumped) a 100%-off product discount covers
    // one unit. A 100%-off ORDER code stays targetSelection ALL and cannot
    // trip this, so staff comp orders pass untouched.
    const isGiftLine =
      (subtotal > 0 && productScopedTotal >= subtotal - EPSILON) ||
      hasFullPercentProductDiscount;
    if (!isGiftLine) {
      continue;
    }

    const tier = matchTier(tiers, line?.merchandise?.product?.id);
    if (tier && tier.minimumSpend > requiredSpend) {
      requiredSpend = tier.minimumSpend;
    }
  }

  let paidForProducts = perLinePaid;
  if (sawApplicationTotal) {
    let totalDiscounts = 0;
    for (const total of applicationTotals.values()) {
      totalDiscounts += total;
    }
    paidForProducts = Math.max(0, grossSubtotal - totalDiscounts);
  }

  if (requiredSpend > 0 && paidForProducts < requiredSpend - EPSILON) {
    return {
      operations: [
        {
          validationAdd: {
            errors: [
              {
                message: config.message ?? defaultMessage(requiredSpend),
                target: "$.cart",
              },
            ],
          },
        },
      ],
    };
  }

  return { operations: [] };
}

// Applications carry no id in this schema; two allocations belong to the same
// application when every descriptive field matches. A collision between two
// genuinely different discounts merges them and UNDER-counts the discount,
// which can only make the guard more lenient (fail-open).
function applicationKey(application) {
  const value = application.value ?? {};
  return [
    application.targetSelection,
    application.targetType,
    application.allocationMethod,
    value.__typename,
    value.value ?? value.amount,
    application.totalAllocatedAmount?.amount,
  ].join("|");
}

// Pinned tiers win over the catch-all; a gift matching no tier is not
// enforced (fail-open).
function matchTier(tiers, productId) {
  const key = productKey(productId);
  if (key) {
    const pinned = tiers.find(
      (tier) => tier.giftProductIds.length > 0 && tier.giftProductIds.includes(key)
    );
    if (pinned) {
      return pinned;
    }
  }
  return tiers.find((tier) => tier.giftProductIds.length === 0) ?? null;
}

// Product ids in the metafield may be full gids or the bare number from the
// admin URL; both compare on the numeric tail so a pasted number is never a
// silent no-match.
function productKey(id) {
  if (id == null) {
    return "";
  }
  const text = String(id).trim();
  if (text.length === 0) {
    return "";
  }
  return text.split("/").pop().split("?")[0];
}

function readConfig(input) {
  const raw = input?.shop?.metafield?.value;
  if (typeof raw !== "string" || raw.length === 0) {
    return DEFAULTS;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULTS;
  }
  if (parsed == null || typeof parsed !== "object") {
    return DEFAULTS;
  }

  const message =
    typeof parsed.message === "string" && parsed.message.trim().length > 0
      ? parsed.message
      : DEFAULTS.message;
  const currency =
    typeof parsed.currency === "string" && /^[A-Za-z]{3}$/.test(parsed.currency.trim())
      ? parsed.currency.trim().toUpperCase()
      : DEFAULTS.currency;

  if (Array.isArray(parsed.tiers)) {
    const tiers = parsed.tiers.map(normalizeTier).filter((tier) => tier !== null);
    return tiers.length > 0 ? { tiers, message, currency } : { ...DEFAULTS, message, currency };
  }

  const flat = normalizeTier(parsed);
  return flat ? { tiers: [flat], message, currency } : { ...DEFAULTS, message, currency };
}

function normalizeTier(entry) {
  if (entry == null || typeof entry !== "object") {
    return null;
  }
  const spend = Number(entry.minimum_spend);
  if (!Number.isFinite(spend)) {
    return null;
  }
  const giftProductIds = Array.isArray(entry.gift_product_ids)
    ? entry.gift_product_ids.map(productKey).filter((id) => id.length > 0)
    : [];
  return { minimumSpend: spend, giftProductIds };
}

function defaultMessage(minimumSpend) {
  const amount = Number.isInteger(minimumSpend)
    ? String(minimumSpend)
    : minimumSpend.toFixed(2);
  return `Free gift needs $${amount} after discounts. Add more or remove the code to check out.`;
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
