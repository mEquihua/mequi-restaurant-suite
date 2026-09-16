# Restaurant Suite — Design Reference Guide

## 1. Chosen reference

**Square Food & Beverage / Square Restaurants**  
Live reference: <https://squareup.com/us/en/point-of-sale/restaurants> (reviewed 15 September 2026).

Square is a live restaurant platform spanning quick-service POS, table management, kitchen workflows, and self-service kiosks. It is operational first—clear hierarchy, decisive actions, and recognisable order states—while retaining an approachable hospitality feel. Its restrained, contemporary UI is a better fit than a generic dashboard template: food, service speed, and real-world users are central to the experience.

## 2. Why it fits Restaurant Suite

Adopt the *one system, role-appropriate surface* principle. Admin and reporting screens can use a dense desktop shell: persistent navigation, filterable tables, small-but-legible metrics, and drill-down views. POS, staff mobile, KDS, and kiosk screens should use the same tokens and status vocabulary but change the density: large menu tiles, prominent totals/timers, shallow navigation, and actions that are obvious at a glance. This keeps a manager's report and a line cook's ticket visually related without forcing either into a compromised layout.

## 3. Color approach

Use a calm neutral foundation (warm off-white/light stone in light mode; charcoal in dark mode), one confident brand accent, and a limited semantic state layer. Reserve semantic colors for meaningful states: neutral for draft/new, amber for attention, blue for in progress, green for ready/paid, and red for blocked, voided, or allergy risk. Pair each with a text label and, where useful, an icon or timer. In dark mode, lift surfaces and borders rather than simply inverting white; preserve contrast without neon saturation.

## 4. Typography

Choose a legible sans-serif family with a broad weight range; use a restrained display companion only for customer-facing promotional/menu moments. Create two type modes. Admin/POS prioritises tabular numerals, compact line height, and 12–16 px supporting text. Kiosk/customer prioritises 18–24 px body and action text, 32 px+ hierarchy for key choices, and concise labels. Prices, quantities, order numbers, and timers must be easy to scan.

## 5. Layout and spacing principles

Base layouts on a 4 px spacing unit, with common steps of 8, 12, 16, 24, and 32 px. Use a structured desktop grid for admin and configurable panels for POS; preserve a clear, persistent order/cart area where needed. Provide density presets rather than one responsive compromise: **compact** for reporting and staff POS, **standard** for general admin, and **spacious** for kiosk/QR ordering. KDS should favour full-width ticket lanes, minimal chrome, and predictable placement of timers and completion controls.

## 6. Component patterns worth reusing

- Cards should group one decision or one order/ticket, with a crisp title, source/table identifier, age/timer, state, and primary next action.
- Status badges/pills need a documented state matrix, not ad-hoc colors. Show text labels such as “New”, “Firing”, “Ready”, “Paid”, or “Allergen alert”; avoid relying on tiny colored dots.
- Data tables should support sticky headers, sensible column priorities, filters, saved views, and a useful row-detail path instead of cramming every attribute into cells.
- Buttons must have an unambiguous primary action, destructive confirmation where appropriate, and large touch variants for POS/kiosk. Use icon-plus-label for consequential actions.
- Empty, loading, offline, and error states should explain what is happening, preserve safe context, and offer a clear recovery action; kitchen/POS screens must make stale or disconnected data unmistakable.

## 7. Accessibility notes

Meet WCAG AA contrast at minimum, including badges and disabled-looking-but-informative text. Customer-facing touch controls should be at least 44 × 44 CSS px, with generous spacing and visible focus states; make primary kiosk choices materially larger. Critical information—especially allergens, unavailable items, payment failures, and overdue tickets—must never be communicated by color alone. Support screen readers with meaningful labels and announce live order-status changes without overwhelming users.

## 8. What NOT to copy

This is a reference for product direction and systemic thinking, not permission to copy Square assets, screens, wording, code, logos, or branding. Square names and marks are trademarks, and its site imagery/interface is protected content. Do not assume its fonts, icons, or components are licensed for reuse: select separately licensed alternatives, retain their license notices, and confirm commercial/self-hosted use terms before adoption.
