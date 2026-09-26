# GWP Guard

A one-function Shopify app that enforces a gift-with-purchase minimum
**after every discount is applied**. Built for Shopify Plus stores that run
"spend $X, get Y free" and let customers stack discount codes on top.

Production on [Empress Athleticus](https://www.empressathleticus.com.au) since
August 2026. Shared as a reference implementation: ~200 lines of JavaScript,
zero runtime dependencies, no servers, configured from one shop metafield.

---

## The problem

Shopify's native Buy X Get Y discount checks its "minimum purchase amount"
**before** discount codes are applied. If the gift discount is set to combine
with order discounts (so customers can use their rewards codes), this happens:

| Cart | Code | Paid | Gift |
|------|------|------|------|
| $320 of product | none | $320 | attached, correct |
| $320 of product | 20% off | **$256** | still attached |

The customer walks away with a $95 gift on a $256 order. Every stacked order
under-pays the threshold by the value of the code, and there is no native
setting that checks the minimum after codes.

Things that do **not** solve it (all investigated first):

- **Turning off discount combinations** works but is blunt: customers must
  choose between their code and the gift.
- **Raising the threshold** (e.g. to $350) just moves the leak to bigger codes.
- **Discount Functions** run in isolation and cannot see other discounts.
- **The Discounts Allocator API** could do it but is developer-preview only.
- **Gift-with-purchase apps** decide on the cart page; codes are entered at
  checkout, after the decision was made.

What does solve it: a **Cart and Checkout Validation Function**. It runs
server-side on every checkout, including Shop Pay, Apple Pay, Google Pay and
PayPal express, sees every discount allocation, and can refuse an order.

## What it does

One rule, evaluated at checkout:

> If the cart contains a free gift (a product made free by a product-scoped
> discount) and the amount actually being paid for products after **all**
> discounts is under the configured minimum, block checkout with a short
> message.

Stacking stays enabled. A $350 cart with a 15% code pays $297.50 and keeps
both the code and the gift. A $320 cart with a 20% code is asked to add more
or drop the code.

Default message: *"Free gift needs $295 after discounts. Add more or remove
the code to check out."*

---

## How it works

```
extensions/gwp-guard/
  shopify.extension.toml                       target: cart.validations.generate.run
  src/cart_validations_generate_run.graphql    input query (what Shopify hands the function)
  src/cart_validations_generate_run.js         the rule (~200 lines, pure function)
  src/cart_validations_generate_run.test.js    41 tests, node --test, zero deps
  schema.graphql                               Shopify function API schema (for typegen)
shopify.app.toml                               extension-only app, no scopes
```

### 1. Checkout only, never cart edits

The function returns nothing unless `buyerJourney.step` is
`CHECKOUT_INTERACTION` or `CHECKOUT_COMPLETION`. Shopify also runs
validations on every **cart change** and refuses any change that would create
a failing state. Enforcing there deadlocks carts: with a free gift, a paid copy
of the same product and a code in the cart, removing the paid item drops the
total further (refused), and removing the free item makes the automatic
discount hop onto the paid copy (still refused). Nothing can be removed.
Codes are entered at checkout anyway, so checkout-only enforcement loses
nothing. (Live incident, see Lessons.)

### 2. The spend maths

```
paid_for_products = gross merchandise subtotal
                  - sum over DISTINCT discount applications of totalAllocatedAmount
```

`totalAllocatedAmount` is Shopify's own cart-wide figure per discount. The
function deduplicates applications by signature (target selection, type,
allocation method, value, total) and ignores shipping-line discounts.

It deliberately does **not** sum per-line `discountedAmount` values. When
Shopify splits one variant across several lines it repeats the group's
allocations on every split line, so a per-line sum double-counts the discount.
That produced a false block on a legitimate $295.40 order (see Lessons).
Per-line sums survive only as a fallback when no application carries a total,
and a signature collision between two genuinely different discounts merges
them, which under-counts the discount, i.e. fails open.

### 3. Gift detection

A line is a gift line when a **product-scoped** discount (any
`targetSelection` other than `ALL`) either:

- nets the whole line to $0, or
- is a 100% percentage discount whose allocation covers at least one unit
  (catches a gift whose quantity was bumped, where one unit is free and one
  is paid).

Two things are explicitly **not** gift evidence:

- The $0.00 allocation Shopify stamps on every line an automatic BXGY did not
  discount. Every line in a gift cart carries one of these.
- 100%-off **order**-scoped codes (staff comps). They stay `targetSelection:
  ALL` and are treated as ordinary discounts.

### 4. Which gifts count: generic vs pinned

- `gift_product_ids: []` **generic mode** - any product made free by a
  product-scoped discount is the gift. Gift rotations need no config change.
  Do not use it if any other 100%-off product mechanic can be live (a
  buy-2-get-1, a loyalty free-product reward, a 100%-off product code): those
  would be held to the same minimum.
- `gift_product_ids: ["gid://shopify/Product/123", ...]` **pinned mode** -
  only those products count. IDs may be full gids or the bare number from the
  admin URL.

### 5. Tiers

```json
{ "tiers": [
    { "minimum_spend": 295, "gift_product_ids": ["gid://shopify/Product/AAA"] },
    { "minimum_spend": 450, "gift_product_ids": ["gid://shopify/Product/BBB"] }
] }
```

Each gift is held to its own tier's floor; checkout must cover the highest
floor among the gifts present. Pinned tiers match first; a tier with `[]` is
the catch-all; a gift matching no tier is not enforced; `minimum_spend: 0`
disables a tier. Tiered *giving* is configured in Shopify as two automatic
BXGY discounts, both with "combines with other product discounts" ticked,
otherwise Shopify applies only the single best one.

### 6. Fail-open, always

Every uncertain path resolves to "do not block":

- no metafield, malformed JSON, unrecognised shape -> guard off
- gift product matches no tier -> not enforced
- `minimum_spend` 0 -> tier off
- `buyerJourney` missing -> pass
- cart currency does not match `currency` -> pass
- allocation data missing -> spend still counted, gift not detected
- application signature collision -> discount under-counted -> more lenient
- function crash -> leave the checkout rule's "block if app experiences a
  problem" UNTICKED so Shopify lets the order through

Misconfiguration can cost margin (the leak returns) but can never block a
legitimate checkout.

---

## Configuration

All config is one shop metafield: namespace `custom`, key `gwp_guard`, type
`json`. Create the definition once (Settings -> Custom data -> Shop -> Add
definition, or the mutation below), then edit the value in the admin or via
the API. Changes apply on the next checkout; **no redeploy, ever**.

```json
{
  "minimum_spend": 295,
  "gift_product_ids": [],
  "currency": "AUD",
  "message": "Free gift needs $295 after discounts. Add more or remove the code to check out."
}
```

| Key | Meaning |
|-----|---------|
| `minimum_spend` | Post-discount product spend the gift requires. `0` = guard off. |
| `gift_product_ids` | `[]` generic, or a list of product ids (gid or bare number). |
| `tiers` | Alternative to the two keys above; see Tiers. |
| `currency` | Optional ISO code. Carts in other currencies are ignored. Unset = enforce everywhere. |
| `message` | Optional. Default is generated from the amount. |

Set it with the Admin GraphQL API:

```graphql
mutation {
  metafieldsSet(metafields: [{
    ownerId: "gid://shopify/Shop/YOUR_SHOP_ID",
    namespace: "custom", key: "gwp_guard", type: "json",
    value: "{\"minimum_spend\":295,\"gift_product_ids\":[],\"currency\":\"AUD\"}"
  }]) { metafields { id value } userErrors { field message } }
}
```

The metafield's `minimum_spend` and the BXGY discount's own minimum are two
dials: keep them on the same number.

---

## Requirements

- **Shopify Plus.** Custom apps containing Shopify Functions only run on Plus
  stores. (Public App Store apps with functions run on any plan; publishing
  this as one needs a settings UI, compliance webhooks and app review.)
- A Shopify Dev Dashboard organisation, Node 18+, and the Shopify CLI
  (installed by `npm install`).
- A live automatic Buy X Get Y discount that gives the gift, set to combine
  with whichever discount classes you allow to stack.

## Deploy

1. **Create the app** in the Dev Dashboard (Apps -> Create app). Copy its
   Client ID into `shopify.app.toml`.
2. `npm install`
3. `npx shopify app deploy` - logs in on first run, builds the function, and
   releases a version. On Windows PowerShell use `npx.cmd` and
   `--allow-updates`; `&&` is not valid there.
4. **Install on the store.** The Dev Dashboard's Install button bounces
   extension-only apps to the app URL without installing; use the direct
   link instead:
   `https://admin.shopify.com/store/YOUR_STORE/oauth/install?client_id=YOUR_CLIENT_ID`
   A landing on the app URL after Install is normal. If you see
   `failed_grant_with_invalid_scopes`, the `[access_scopes]` block is missing
   from the deployed config.
5. **Activate.** Settings -> Checkout -> Checkout rules -> Add rule ->
   GWP Guard -> give it a title, set Active, leave "Block checkout if app
   experiences a problem" **unticked** -> Save.
6. **Configure** the metafield (above). Until it exists the guard is off.
7. **Test** on the live store (five minutes):

| Cart | Code | Expect |
|------|------|--------|
| well over the floor + gift | none | checkout fine |
| well over the floor + gift | small code, still over | keeps gift and code, checkout fine |
| just over the floor + gift | code that takes it under | blocked with the message |
| the blocked cart, remove the code | - | clears instantly, gift kept |
| under the floor, no gift | any code | checkout fine |
| in the cart, remove a paid item from a blocked cart | - | removal works |

Later changes (thresholds, gift products, message) are metafield edits.
Code changes are `npx shopify app deploy` again; the login is cached.

## Reading what the function saw

Every run is logged in the Dev Dashboard (App -> Logs) with its exact input
and output. Wide time ranges are **sampled**; narrow the range to a few
minutes around the event (the URL takes `?time=START..END` in UTC) for a
complete set, then open a run to see `buyerJourney.step`, every line's
allocations and the returned operations. This is how the split-line bug was
found: the logged input showed the duplicated allocations directly.

## Campaign checklist

Things that interact with the guard. Read before every sale.

- **Sitewide automatic percentage sales.** The guard counts every discount
  against the floor and cannot tell a sale from a code. A 40% automatic sale
  drags most gift carts under the floor. Before one: set `minimum_spend` to
  the intended post-sale figure, set it to 0 for the sale, or raise the BXGY
  minimum instead. Hard markdowns (changing prices) create no allocations and
  are invisible to the guard.
- **Any other 100%-off product mechanic** while in generic mode: switch to
  pinned mode first.
- **100% order codes** (staff comps) with the gift attached compute paid $0
  and block: drop the gift on comp orders.
- **API version.** `api_version = "2026-04"` is sunset roughly a year after
  release; bump both toml files and redeploy before then.

---

## Lessons from production

The guard shipped on 24 August 2026 and needed three fixes in its first
three weeks. Each one is now a test.

1. **Cart deadlock (7 Sep).** v1 enforced during cart edits too. A customer
   with a free gift, a paid copy of the gift product and a code could not
   remove anything; every possible edit was refused, and they posted about it
   publicly. Fix: `buyerJourney.step` gate, checkout only.
2. **Split-line double count (10 Sep).** A customer with a $295.40 post-code
   cart was blocked. The function log showed Shopify had split a quantity-2
   line into two lines and listed the pair's whole allocation on each; the
   per-line sum subtracted the discount twice. Fix: sum distinct application
   totals, never lines. The exact logged input is in the test suite.
3. **$0 markers.** Shopify stamps the BXGY application on every line with a
   $0.00 allocation. Harmless in generic mode, but it made every line look
   like a gift line to the tier matcher. Fix: an allocation must cover at
   least one unit to count.
4. **Install trap.** Without an explicit empty `[access_scopes]` block the
   deployed config is invalid for installation; the Dev Dashboard button then
   bounces silently to the app URL.
5. **"Only the biggest discount applies."** Two automatic discounts combine
   only if *both* tick the combination box for each other's class; otherwise
   Shopify silently applies the single best one. It is a checkbox, not a
   platform limit.
6. **Native BXGY never auto-adds the gift.** Customers add it themselves;
   auto-add is a third-party app feature.
7. **Check for a completed order before debugging a "false block".** And
   check *how* it completed: a manually added gift line looks identical to a
   pass.

## Tests

```bash
npm test
```

41 tests using Node's built-in runner: stacking preserved, leak blocked,
exact-floor boundary, gift quantity bumped, staff 100% order codes, loyalty
free products in pinned mode, fixed-amount product discounts, per-discount
totals path, the split-line replay, $0 markers, shipping discounts, buyer
journey scoping, currency, tiers, product id forms, and every fail-open path.

## Status

Reference implementation shared by Empress Athleticus. No licence is granted
by default; ask before redistributing. Built with Claude Code.
