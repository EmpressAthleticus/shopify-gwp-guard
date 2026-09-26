# Changelog

## 1.5.0 (kit) - 2026-09-26

Shared reference version. Differences from the production build:

- Guard is **off until the shop metafield exists** (production defaulted to
  a $295 generic floor).
- `currency` is a metafield key instead of a hardcoded constant; unset means
  enforce in every presentment currency.
- Extension handle `gwp-guard`; store identifiers removed from config.

## 1.4.0 - 2026-09-10

- Pinned `gift_product_ids` accept the bare product number from the admin
  URL as well as the full gid.
- Campaign checklist and runbook in the README.

## 1.3.0 - 2026-09-10

- Spend is computed from each distinct discount application's
  `totalAllocatedAmount`, never per-line sums (split-line double count caused
  a false block at $295.40).
- $0 BXGY markers on undiscounted lines no longer count as gift evidence.
- Shipping-line discounts ignored.

## 1.2.0 - 2026-09-07

- Enforce only during `CHECKOUT_INTERACTION` / `CHECKOUT_COMPLETION`.
  Enforcing on cart edits deadlocked carts holding a free gift, a paid copy
  of the gift product and a code.

## 1.1.0 - 2026-08-24

- Tiered config: each gift held to its own floor.

## 1.0.0 - 2026-08-24

- Initial release: post-discount minimum for a gift-with-purchase, configured
  from a shop metafield, fail-open throughout.
