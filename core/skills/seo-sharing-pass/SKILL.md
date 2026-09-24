---
name: seo-sharing-pass
description: Post-build SEO & sharing pass checklist. Covers metadata, OG tags, twitter:card, og:image, favicon sets, sitemap/robots, noindex enforcement, and verification. Loaded by seo-worker. Do not load for pure audit/strategy questions.
---

## seo-sharing-pass

This skill is the worker spec as a loadable checklist for the `seo-worker`.

### 1. Idempotency rule
Before writing any field, scan existing source files. If a field exists and is NOT tagged `<!-- seo:auto -->` in HTML or `# seo:auto` comment in JS/TS config, mark it as `human_written` and skip it. Only overwrite fields tagged auto-generated.

### 2. Production URL Halt Rule
Received as input. If missing/empty → output FAIL immediately with message "HALT: production_url is required. Provide PRODUCTION_URL env var or site config key." Do not proceed.

### 3. Worker spec (Ordered Checklist)
a. **General metadata per page**: title ≤60 chars from page content, description ≤160, html lang, viewport, absolute canonical, theme-color, favicon set (ico + svg or png + apple-touch-icon). Noindex on pages matching: 404, /admin/*, /thank-you*, /success*, /dashboard/*, /private/*.
b. **Link preview per page**: og:title, og:description, og:type, og:url (absolute), og:site_name, og:locale, og:image (absolute URL, 1200x630, PNG/JPG, <1 MB, on production domain), og:image:width=1200, og:image:height=630, og:image:alt. twitter:card=summary_large_image, twitter:title, twitter:description, twitter:image. Reuse existing brand asset if found (scan: /public/, /assets/, /static/, root). If absent: generate a simple image using Node sharp (if available) or Python PIL (if available), else write TODO:SEO-IMAGE placeholder and log to report.
c. **Sitemap + robots**: use framework native mechanism (refer to `seo-engineering` section 1). Generate /sitemap.xml at build time from real route list with absolute URLs. Exclude noindex pages, 404s, non-canonical pages. Include lastmod only from real dates (git log or frontmatter). /robots.txt: reference sitemap, disallow nothing the user hasn't specified.

### 4. Verification command cheat sheet
Refer to `seo-engineering` section 6 for commands to verify canonicals, robots directives, JSON-LD, sitemaps, hreflang, Open Graph, and Twitter Cards.

### 5. Report Template
```
## SEO & Sharing Pass Report — {site_name} — {ISO date}

### Files changed
- path: description

### TODOs / placeholders unfilled
- field on page X: reason

### Skipped items & reasons
- item: reason

### Verification results
| Check | Result | Detail |
|---|---|---|
| Build passes | PASS/FAIL | |
| Sitemap valid XML | PASS/FAIL | |
| All sitemap URLs return 200 | PASS/PRE-DEPLOY/FAIL | |
| Each page: exactly one title | PASS/FAIL | duplicates listed |
| Each page: exactly one description | PASS/FAIL | |
| Each page: exactly one canonical | PASS/FAIL | |
| No cross-page title duplicates | PASS/FAIL | |
| og:image resolves (image content-type) | PASS/PRE-DEPLOY/FAIL | |
| og:image dimensions 1200x630 | PASS/PRE-DEPLOY/FAIL | |
| og:image < 1 MB | PASS/FAIL | |
| No relative URLs in og:/twitter: tags | PASS/FAIL | |

### Overall: PASS / FAIL — Block deploy: YES / NO

### Manual follow-up (post-deploy)
- [ ] Facebook Sharing Debugger: https://developers.facebook.com/tools/debug/
- [ ] LinkedIn Post Inspector: https://www.linkedin.com/post-inspector/
- [ ] If previews stale, force re-scrape in each tool.
```

### 6. Failure/Escalation protocol
The agent tracks `retry_count` (passed in context). If called with retry_count=3, output the report with FAIL and message "ESCALATE: 3 attempts exhausted. Returning to lead-dev for user review." Do not loop further.
