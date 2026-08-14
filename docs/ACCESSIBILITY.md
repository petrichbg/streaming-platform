# Accessibility audit

Target: WCAG 2.2 AA. Audited at desktop and 390 × 844 mobile viewports against the production build.

## Verified

- Bulgarian document language and a working skip link to `#main-content`.
- Visible global `:focus-visible` treatment and keyboard-operable catalog, carousel, filters, profile menu, and player controls.
- `Ctrl/Cmd + K` focuses and selects the catalog search; `Escape` clears and dismisses it.
- Featured carousel exposes a named region, labelled slide controls, current-slide state, a persistent pause/play control, hover/focus pause, and no automatic motion under `prefers-reduced-motion`.
- Loading states use `aria-busy` and structural skeletons without announcing decorative shimmer elements.
- Mobile player controls have accessible names and at least 48 px touch targets.
- Mobile browse and player pages have no horizontal document overflow at 390 px.
- Status and focus communication do not rely on colour alone.
- Browser console remained free of warnings and errors during browse, carousel, search, and player checks.

## Ongoing checks

Run frontend lint, typecheck, and production build for every pull request. Repeat browser checks when navigation, carousel, forms, or player controls change.
