import { test } from "node:test";
import assert from "node:assert/strict";
import { cartValidationsGenerateRun } from "./cart_validations_generate_run.js";

const PASS = { operations: [] };
// A typical live config: generic mode, $295 floor, AUD only.
const GENERIC = JSON.stringify({ minimum_spend: 295, gift_product_ids: [], currency: "AUD" });
const JOGGER = "gid://shopify/Product/8470256746686";
const HOODIE = "gid://shopify/Product/2222";
const SCRUNCHIE = "gid://shopify/Product/1111";
const OTHER = "gid://shopify/Product/9999";

function money(amount) {
  return { amount: String(amount) };
}

function line({ subtotal, unitPrice, quantity = 1, allocations = [], productId = OTHER }) {
  return {
    quantity,
    cost: {
      subtotalAmount: money(subtotal),
      amountPerQuantity: money(unitPrice ?? subtotal),
    },
    discountAllocations: allocations,
    merchandise: {
      __typename: "ProductVariant",
      id: `${productId}-variant`,
      product: { id: productId },
    },
  };
}

function withTotal(application, total) {
  return total === undefined
    ? application
    : { ...application, totalAllocatedAmount: money(total) };
}

// A GWP automatic BXGY: product-scoped (ENTITLED), 100% off. `total` is the
// application's cart-wide totalAllocatedAmount (omit to exercise the
// per-line fallback path).
function giftAllocation(amount, total) {
  return {
    discountedAmount: money(amount),
    discountApplication: withTotal(
      {
        targetSelection: "ENTITLED",
        targetType: "LINE_ITEM",
        allocationMethod: "EACH",
        value: { __typename: "PricingPercentageValue", value: 100.0 },
      },
      total
    ),
  };
}

// The $0.00 stamp Shopify puts on every line the BXGY did NOT discount.
function giftMarker(total) {
  return giftAllocation(0, total);
}

// A rewards code: order-scoped (ALL), percentage, allocated across lines.
function orderCodeAllocation(amount, percentage, total) {
  return {
    discountedAmount: money(amount),
    discountApplication: withTotal(
      {
        targetSelection: "ALL",
        targetType: "LINE_ITEM",
        allocationMethod: "ACROSS",
        value: { __typename: "PricingPercentageValue", value: percentage },
      },
      total
    ),
  };
}

function shippingAllocation(amount, total) {
  return {
    discountedAmount: money(amount),
    discountApplication: withTotal(
      {
        targetSelection: "ALL",
        targetType: "SHIPPING_LINE",
        allocationMethod: "ACROSS",
        value: { __typename: "PricingPercentageValue", value: 100.0 },
      },
      total
    ),
  };
}

function cart(lines, { currencyCode = "AUD", metafieldValue = GENERIC, step = "CHECKOUT_INTERACTION" } = {}) {
  const subtotal = lines.reduce(
    (sum, l) => sum + Number(l.cost.subtotalAmount.amount),
    0
  );
  return {
    shop: { metafield: metafieldValue == null ? null : { value: metafieldValue } },
    buyerJourney: step == null ? null : { step },
    cart: {
      cost: { subtotalAmount: { amount: String(subtotal), currencyCode } },
      lines,
    },
  };
}

function expectBlocked(result, amountPattern = /\$295/) {
  assert.equal(result.operations.length, 1);
  const errors = result.operations[0].validationAdd.errors;
  assert.equal(errors.length, 1);
  assert.equal(errors[0].target, "$.cart");
  assert.match(errors[0].message, amountPattern);
}

const PINNED = JSON.stringify({ minimum_spend: 295, gift_product_ids: [JOGGER] });

// ---- flat config, per-line fallback path (no application totals) ----

test("empty cart passes", () => {
  assert.deepEqual(cartValidationsGenerateRun(cart([])), PASS);
});

test("no gift, no codes passes", () => {
  assert.deepEqual(cartValidationsGenerateRun(cart([line({ subtotal: 350 })])), PASS);
});

test("gift with $350 spend and no code passes", () => {
  const input = cart([
    line({ subtotal: 350 }),
    line({ subtotal: 95, productId: JOGGER, allocations: [giftAllocation(95)] }),
  ]);
  assert.deepEqual(cartValidationsGenerateRun(input), PASS);
});

test("stacking preserved: $350 cart with 15% code pays $297.50 and keeps the gift", () => {
  const input = cart([
    line({ subtotal: 350, allocations: [orderCodeAllocation(52.5, 15)] }),
    line({ subtotal: 95, productId: JOGGER, allocations: [giftAllocation(95)] }),
  ]);
  assert.deepEqual(cartValidationsGenerateRun(input), PASS);
});

test("leak closed: $320 cart with 20% code pays $256 and is blocked", () => {
  const input = cart([
    line({ subtotal: 320, allocations: [orderCodeAllocation(64, 20)] }),
    line({ subtotal: 95, productId: JOGGER, allocations: [giftAllocation(95)] }),
  ]);
  expectBlocked(cartValidationsGenerateRun(input));
});

test("exactly $295 after the code passes", () => {
  const input = cart([
    line({ subtotal: 368.75, allocations: [orderCodeAllocation(73.75, 20)] }),
    line({ subtotal: 95, productId: JOGGER, allocations: [giftAllocation(95)] }),
  ]);
  assert.deepEqual(cartValidationsGenerateRun(input), PASS);
});

test("just under $295 after the code is blocked", () => {
  const input = cart([
    line({ subtotal: 345, allocations: [orderCodeAllocation(51.75, 15)] }),
    line({ subtotal: 95, productId: JOGGER, allocations: [giftAllocation(95)] }),
  ]);
  expectBlocked(cartValidationsGenerateRun(input));
});

test("gift quantity bumped to 2: paid jogger counts, gift still detected", () => {
  const input = cart([
    line({
      subtotal: 190,
      unitPrice: 95,
      quantity: 2,
      productId: JOGGER,
      allocations: [giftAllocation(95), orderCodeAllocation(14.25, 15)],
    }),
    line({ subtotal: 150, allocations: [orderCodeAllocation(22.5, 15)] }),
  ]);
  // Paid: (190 - 95 - 14.25) + (150 - 22.5) = 208.25 < 295
  expectBlocked(cartValidationsGenerateRun(input));
});

test("100% order-scoped code (staff comp) is not treated as a gift", () => {
  const input = cart([
    line({ subtotal: 200, allocations: [orderCodeAllocation(200, 100)] }),
    line({ subtotal: 80, productId: JOGGER, allocations: [orderCodeAllocation(80, 100)] }),
  ]);
  assert.deepEqual(cartValidationsGenerateRun(input), PASS);
});

test("pinned config: a 100%-off product that is not the pinned gift passes", () => {
  const input = cart(
    [
      line({ subtotal: 120 }),
      line({ subtotal: 25, productId: SCRUNCHIE, allocations: [giftAllocation(25)] }),
    ],
    { metafieldValue: PINNED }
  );
  assert.deepEqual(cartValidationsGenerateRun(input), PASS);
});

test("generic mode: any free gift is enforced at the floor", () => {
  const input = cart([
    line({ subtotal: 100, allocations: [orderCodeAllocation(20, 20)] }),
    line({ subtotal: 25, productId: SCRUNCHIE, allocations: [giftAllocation(25)] }),
  ]);
  expectBlocked(cartValidationsGenerateRun(input));
});

test("no metafield: the guard is OFF until configured", () => {
  const input = cart(
    [
      line({ subtotal: 100, allocations: [orderCodeAllocation(20, 20)] }),
      line({ subtotal: 25, productId: SCRUNCHIE, allocations: [giftAllocation(25)] }),
    ],
    { metafieldValue: null }
  );
  assert.deepEqual(cartValidationsGenerateRun(input), PASS);
});

test("currency unset: enforced in every presentment currency", () => {
  const input = cart(
    [
      line({ subtotal: 320, allocations: [orderCodeAllocation(64, 20)] }),
      line({ subtotal: 95, productId: JOGGER, allocations: [giftAllocation(95)] }),
    ],
    { currencyCode: "NZD", metafieldValue: JSON.stringify({ minimum_spend: 295, gift_product_ids: [] }) }
  );
  expectBlocked(cartValidationsGenerateRun(input));
});

test("fixed-amount product discount making the gift line free is detected", () => {
  const input = cart([
    line({ subtotal: 200, allocations: [orderCodeAllocation(30, 15)] }),
    line({
      subtotal: 95,
      productId: JOGGER,
      allocations: [
        {
          discountedAmount: money(95),
          discountApplication: {
            targetSelection: "ENTITLED",
            targetType: "LINE_ITEM",
            allocationMethod: "EACH",
            value: { __typename: "MoneyV2", amount: "95.0" },
          },
        },
      ],
    }),
  ]);
  expectBlocked(cartValidationsGenerateRun(input));
});

test("non-AUD carts keep today's behaviour", () => {
  const input = cart(
    [
      line({ subtotal: 320, allocations: [orderCodeAllocation(64, 20)] }),
      line({ subtotal: 95, productId: JOGGER, allocations: [giftAllocation(95)] }),
    ],
    { currencyCode: "NZD" }
  );
  assert.deepEqual(cartValidationsGenerateRun(input), PASS);
});

test("missing discountApplication data fails open on detection but still counts spend", () => {
  const input = cart([
    line({ subtotal: 320, allocations: [{ discountedAmount: money(64) }] }),
    line({ subtotal: 95, productId: JOGGER, allocations: [{ discountedAmount: money(95) }] }),
  ]);
  assert.deepEqual(cartValidationsGenerateRun(input), PASS);
});

test("kill switch: minimum_spend 0 disables the guard", () => {
  const input = cart(
    [
      line({ subtotal: 100, allocations: [orderCodeAllocation(50, 50)] }),
      line({ subtotal: 95, productId: JOGGER, allocations: [giftAllocation(95)] }),
    ],
    { metafieldValue: JSON.stringify({ minimum_spend: 0 }) }
  );
  assert.deepEqual(cartValidationsGenerateRun(input), PASS);
});

test("custom message override is used verbatim", () => {
  const input = cart(
    [
      line({ subtotal: 200, allocations: [orderCodeAllocation(60, 30)] }),
      line({ subtotal: 95, productId: JOGGER, allocations: [giftAllocation(95)] }),
    ],
    { metafieldValue: JSON.stringify({ minimum_spend: 295, gift_product_ids: [JOGGER], message: "Custom copy here" }) }
  );
  expectBlocked(cartValidationsGenerateRun(input), /Custom copy here/);
});

test("malformed metafield JSON switches the guard off (never a false block)", () => {
  const input = cart(
    [
      line({ subtotal: 320, allocations: [orderCodeAllocation(64, 20)] }),
      line({ subtotal: 95, productId: JOGGER, allocations: [giftAllocation(95)] }),
    ],
    { metafieldValue: "{not json" }
  );
  assert.deepEqual(cartValidationsGenerateRun(input), PASS);
});

// ---- application-total path (Shopify's cart-wide totalAllocatedAmount) ----

test("totals path: $350 cart with 15% code keeps the gift", () => {
  const input = cart([
    line({ subtotal: 350, allocations: [orderCodeAllocation(52.5, 15, 52.5), giftMarker(95)] }),
    line({ subtotal: 95, productId: JOGGER, allocations: [orderCodeAllocation(0, 15, 52.5), giftAllocation(95, 95)] }),
  ]);
  assert.deepEqual(cartValidationsGenerateRun(input), PASS);
});

test("totals path: $320 cart with 20% code is blocked", () => {
  const input = cart([
    line({ subtotal: 320, allocations: [orderCodeAllocation(64, 20, 64), giftMarker(95)] }),
    line({ subtotal: 95, productId: JOGGER, allocations: [orderCodeAllocation(0, 20, 64), giftAllocation(95, 95)] }),
  ]);
  expectBlocked(cartValidationsGenerateRun(input));
});

test("totals path: exactly $295 after the code passes", () => {
  const input = cart([
    line({ subtotal: 368.75, allocations: [orderCodeAllocation(73.75, 20, 73.75), giftMarker(95)] }),
    line({ subtotal: 95, productId: JOGGER, allocations: [giftAllocation(95, 95)] }),
  ]);
  assert.deepEqual(cartValidationsGenerateRun(input), PASS);
});

// A live false block (10 Sep 2026), replayed from the function log: the
// two $65 shorts arrived as two qty-1 lines, each listing the 30% code twice
// (19.50 + 19.50 — the pair's whole allocation on every split line). Gross
// $517, discounts 95 + 126.60, true paid $295.40.
function splitLineCart(step, withTotals) {
  const t = (v) => (withTotals ? v : undefined);
  const code = (amt) => orderCodeAllocation(amt, 30, t(126.6));
  const marker = () => giftMarker(t(95));
  return cart(
    [
      line({ subtotal: 15, productId: "gid://shopify/Product/8782906261694", allocations: [code(4.5), marker()] }),
      line({ subtotal: 95, productId: JOGGER, allocations: [code(0), giftAllocation(95, t(95))] }),
      line({ subtotal: 60, productId: "gid://shopify/Product/8472979898558", allocations: [code(18), marker()] }),
      line({ subtotal: 76, productId: "gid://shopify/Product/8472979996862", allocations: [code(22.8), marker()] }),
      line({ subtotal: 56, productId: "gid://shopify/Product/8472980029630", allocations: [code(16.8), marker()] }),
      line({ subtotal: 85, productId: "gid://shopify/Product/8659842072766", allocations: [code(25.5), marker()] }),
      line({ subtotal: 65, productId: "gid://shopify/Product/8659842269374", allocations: [code(19.5), code(19.5), marker()] }),
      line({ subtotal: 65, productId: "gid://shopify/Product/8659842269374", allocations: [code(19.5), code(19.5), marker()] }),
    ],
    { step }
  );
}

test("split-line replay: duplicated allocations no longer false-block at $295.40", () => {
  assert.deepEqual(cartValidationsGenerateRun(splitLineCart("CHECKOUT_COMPLETION", true)), PASS);
  assert.deepEqual(cartValidationsGenerateRun(splitLineCart("CHECKOUT_INTERACTION", true)), PASS);
});

test("split-line replay: the per-line fallback still reproduces the old under-count (documents the bug)", () => {
  // Without application totals the only information is per-line, and the
  // duplicated split-line allocations sum to $39 too much. Kept as a
  // characterisation test so the fallback's limitation stays visible.
  expectBlocked(cartValidationsGenerateRun(splitLineCart("CHECKOUT_COMPLETION", false)));
});

test("$0 BXGY markers on paid lines are not gift evidence", () => {
  // Gift not in the cart (only the markers remain), code drags spend under
  // $295: nothing to enforce, must pass.
  const input = cart([
    line({ subtotal: 200, allocations: [orderCodeAllocation(60, 30, 60), giftMarker(0)] }),
    line({ subtotal: 50, allocations: [orderCodeAllocation(0, 30, 60), giftMarker(0)] }),
  ]);
  assert.deepEqual(cartValidationsGenerateRun(input), PASS);
});

test("tiers: a paid pinned product carrying a $0 marker does not raise the floor", () => {
  const tiers = JSON.stringify({
    tiers: [
      { minimum_spend: 295, gift_product_ids: [JOGGER] },
      { minimum_spend: 450, gift_product_ids: [HOODIE] },
    ],
  });
  // Customer BUYS the hoodie (paid, marker only) and gets the jogger free.
  // Paid after code = 300 >= 295; the hoodie must not be read as the $450 gift.
  const input = cart(
    [
      line({ subtotal: 60, productId: HOODIE, allocations: [orderCodeAllocation(12, 20, 75), giftMarker(95)] }),
      line({ subtotal: 315, allocations: [orderCodeAllocation(63, 20, 75), giftMarker(95)] }),
      line({ subtotal: 95, productId: JOGGER, allocations: [orderCodeAllocation(0, 20, 75), giftAllocation(95, 95)] }),
    ],
    { metafieldValue: tiers }
  );
  assert.deepEqual(cartValidationsGenerateRun(input), PASS);
});

test("shipping discounts never reduce product spend", () => {
  const input = cart([
    line({ subtotal: 300, allocations: [orderCodeAllocation(0, 0, 0), shippingAllocation(0, 15), giftMarker(95)] }),
    line({ subtotal: 95, productId: JOGGER, allocations: [giftAllocation(95, 95), shippingAllocation(0, 15)] }),
  ]);
  // Paid 300 exactly >= 295 even though a $15 shipping discount exists.
  assert.deepEqual(cartValidationsGenerateRun(input), PASS);
});

// ---- buyer journey scoping (the 7 Sep cart-deadlock incident) ----

test("cart interaction never blocks: the two-jogger deadlock cart stays editable", () => {
  const input = cart(
    [
      line({ subtotal: 88, allocations: [orderCodeAllocation(8.8, 10)] }),
      line({ subtotal: 95, productId: JOGGER, allocations: [giftAllocation(95)] }),
      line({ subtotal: 95, productId: JOGGER, allocations: [orderCodeAllocation(9.5, 10)] }),
    ],
    { step: "CART_INTERACTION" }
  );
  assert.deepEqual(cartValidationsGenerateRun(input), PASS);
});

test("checkout interaction still blocks the same cart", () => {
  const input = cart(
    [
      line({ subtotal: 88, allocations: [orderCodeAllocation(8.8, 10)] }),
      line({ subtotal: 95, productId: JOGGER, allocations: [giftAllocation(95)] }),
      line({ subtotal: 95, productId: JOGGER, allocations: [orderCodeAllocation(9.5, 10)] }),
    ],
    { step: "CHECKOUT_INTERACTION" }
  );
  expectBlocked(cartValidationsGenerateRun(input));
});

test("checkout completion still blocks a violating cart", () => {
  const input = cart(
    [
      line({ subtotal: 320, allocations: [orderCodeAllocation(64, 20)] }),
      line({ subtotal: 95, productId: JOGGER, allocations: [giftAllocation(95)] }),
    ],
    { step: "CHECKOUT_COMPLETION" }
  );
  expectBlocked(cartValidationsGenerateRun(input));
});

test("missing buyerJourney fails open", () => {
  const input = cart(
    [
      line({ subtotal: 320, allocations: [orderCodeAllocation(64, 20)] }),
      line({ subtotal: 95, productId: JOGGER, allocations: [giftAllocation(95)] }),
    ],
    { step: null }
  );
  assert.deepEqual(cartValidationsGenerateRun(input), PASS);
});

// ---- product id normalisation ----

test("pinned config accepts the bare product number from the admin URL", () => {
  const bare = JSON.stringify({ minimum_spend: 295, gift_product_ids: [8470256746686] });
  const input = cart(
    [
      line({ subtotal: 320, allocations: [orderCodeAllocation(64, 20)] }),
      line({ subtotal: 95, productId: JOGGER, allocations: [giftAllocation(95)] }),
    ],
    { metafieldValue: bare }
  );
  expectBlocked(cartValidationsGenerateRun(input));
});

test("pinned config with a different bare number does not match the gift", () => {
  const other = JSON.stringify({ minimum_spend: 295, gift_product_ids: ["1234567890"] });
  const input = cart(
    [
      line({ subtotal: 320, allocations: [orderCodeAllocation(64, 20)] }),
      line({ subtotal: 95, productId: JOGGER, allocations: [giftAllocation(95)] }),
    ],
    { metafieldValue: other }
  );
  assert.deepEqual(cartValidationsGenerateRun(input), PASS);
});

// ---- tiered config ----

const TIERS = JSON.stringify({
  tiers: [
    { minimum_spend: 295, gift_product_ids: [JOGGER] },
    { minimum_spend: 450, gift_product_ids: [HOODIE] },
  ],
});

function tierCart(paidSubtotal, codeAmount, giftLines, metafieldValue = TIERS) {
  const lines = [
    line({
      subtotal: paidSubtotal,
      allocations: codeAmount > 0 ? [orderCodeAllocation(codeAmount, 20)] : [],
    }),
    ...giftLines,
  ];
  return cart(lines, { metafieldValue });
}

const JOGGER_GIFT = line({ subtotal: 95, productId: JOGGER, allocations: [giftAllocation(95)] });
const HOODIE_GIFT = line({ subtotal: 120, productId: HOODIE, allocations: [giftAllocation(120)] });
const SCRUNCHIE_GIFT = line({ subtotal: 25, productId: SCRUNCHIE, allocations: [giftAllocation(25)] });

test("tiers: both gifts with $500 paid after code passes", () => {
  const input = tierCart(625, 125, [JOGGER_GIFT, HOODIE_GIFT]);
  assert.deepEqual(cartValidationsGenerateRun(input), PASS);
});

test("tiers: both gifts but only $400 paid is blocked at the $450 floor", () => {
  const input = tierCart(500, 100, [JOGGER_GIFT, HOODIE_GIFT]);
  expectBlocked(cartValidationsGenerateRun(input), /\$450/);
});

test("tiers: tier-1 gift alone is only held to its own $295 floor", () => {
  const input = tierCart(400, 80, [JOGGER_GIFT]);
  assert.deepEqual(cartValidationsGenerateRun(input), PASS);
});

test("tiers: tier-2 gift alone under $450 is blocked with the $450 message", () => {
  const input = tierCart(500, 100, [HOODIE_GIFT]);
  expectBlocked(cartValidationsGenerateRun(input), /\$450/);
});

test("tiers: a free product matching no tier is not enforced", () => {
  const input = tierCart(200, 40, [SCRUNCHIE_GIFT]);
  assert.deepEqual(cartValidationsGenerateRun(input), PASS);
});

test("tiers: catch-all tier picks up unpinned gifts, pinned tiers still win", () => {
  const withCatchAll = JSON.stringify({
    tiers: [
      { minimum_spend: 450, gift_product_ids: [HOODIE] },
      { minimum_spend: 295, gift_product_ids: [] },
    ],
  });
  const scrunchieUnder = tierCart(300, 60, [SCRUNCHIE_GIFT], withCatchAll);
  expectBlocked(cartValidationsGenerateRun(scrunchieUnder), /\$295/);

  const hoodieUnder = tierCart(500, 100, [HOODIE_GIFT], withCatchAll);
  expectBlocked(cartValidationsGenerateRun(hoodieUnder), /\$450/);
});

test("tiers: a zero-spend tier is disabled and its gift unenforced", () => {
  const paused = JSON.stringify({
    tiers: [
      { minimum_spend: 0, gift_product_ids: [JOGGER] },
      { minimum_spend: 450, gift_product_ids: [HOODIE] },
    ],
  });
  const input = tierCart(200, 40, [JOGGER_GIFT], paused);
  assert.deepEqual(cartValidationsGenerateRun(input), PASS);
});

test("tiers: entirely invalid tier entries switch the guard off", () => {
  const junk = JSON.stringify({ tiers: [{ nope: true }, "x"] });
  const input = tierCart(300, 60, [JOGGER_GIFT], junk);
  assert.deepEqual(cartValidationsGenerateRun(input), PASS);
});
