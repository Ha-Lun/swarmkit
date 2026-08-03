---
name: seo-engineering
description: Practical SEO engineering recipes — per-framework sitemap generation, free tool recipes (PageSpeed, Schema.org validator), JSON-LD cheat sheet, visibility verification checklist. Complements the existing seo-audit, ai-seo, schema-markup, site-architecture, programmatic-seo, analytics-tracking skills. Load alongside them.
---

# seo-engineering

Practical recipes and cheat sheets for SEO engineering work. The existing skills (`seo-audit`, `ai-seo`, `schema-markup`, `site-architecture`, `programmatic-seo`, `analytics-tracking`) cover the **why**; this skill covers the **how** — concrete commands, file templates, and verification steps.

## When to load

Load this skill whenever you're doing hands-on SEO engineering work — running tools, writing sitemaps, generating JSON-LD, fixing canonical tags. Don't load it for pure strategy/concept questions (those are covered by the other skills).

## 1. Per-framework sitemap generation

### Next.js (App Router, 14+)
Use a custom route at `app/sitemap.ts`:
```ts
// app/sitemap.ts
import { MetadataRoute } from 'next'
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = 'https://example.com'
  const routes = ['', '/about', '/blog'].map(p => ({ url: `${base}${p}`, lastModified: new Date() }))
  // Add dynamic routes from your CMS/DB here
  return [...routes]
}
```
Also add `app/robots.ts`:
```ts
import { MetadataRoute } from 'next'
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: '*', allow: '/', disallow: '/private/' }, sitemap: 'https://example.com/sitemap.xml' }
}
```

### Vite + React SPA
Vite is a SPA — Google indexes JS, but slowly. Generate a static sitemap at build time:
```ts
// scripts/generate-sitemap.ts
import { writeFileSync } from 'fs'
import { globby } from 'globby'
const urls = await globby(['dist/**/*.html'])
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url><loc>https://example.com/${u.replace(/^dist\//, '')}</loc></url>`).join('\n')}
</urlset>`
writeFileSync('dist/sitemap.xml', xml)
```

### Astro
Astro has a built-in `@astrojs/sitemap` integration:
```js
// astro.config.mjs
import sitemap from '@astrojs/sitemap'
export default defineConfig({ integrations: [sitemap()] })
```

### Hugo
```yaml
# config.yaml
sitemap:
  changefreq: weekly
  priority: 0.5
```
Generates `/sitemap.xml` by default. Submit to GSC manually.

### Docusaurus
```js
// docusaurus.config.js
module.exports = {
  plugins: [['@docusaurus/plugin-sitemap', { id: 'sitemap' }]]
}
```

## 2. Free tool recipes

### PageSpeed Insights (no API key)
```bash
# Mobile audit
curl -s "https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=https://example.com&strategy=mobile" | jq '.lighthouseResult.categories.performance.score, .lighthouseResult.audits["largest-contentful-paint"].displayValue, .lighthouseResult.audits["cumulative-layout-shift"].displayValue'
# Desktop audit
curl -s "https://www.googleapis.com/pagespeedonline/v5/runPagespeed?url=https://example.com&strategy=desktop" | jq '.lighthouseResult.categories.performance.score'
```
Rate limit: ~25K queries/day per IP. Cache results locally.

### Schema.org validator (no API)
```bash
curl -s "https://validator.schema.org/url?url=https://example.com/product-page" | grep -E "warnings|errors"
```
For programmatic checks, parse the page's JSON-LD locally:
```bash
node -e "const j=require('cheerio').load(require('fs').readFileSync('page.html','utf8'))('script[type=\"application/ld+json\"]').text(); JSON.parse(j); console.log('valid')"
```

### Manual GSC export (paste-in)
The user can export from GSC → Performance → Pages or Queries → Export CSV. Common fields: `Page`, `Clicks`, `Impressions`, `CTR`, `Position`. When pasted in, group by Page, sort by Impressions desc, and find the high-impression low-CTR pages (snippet optimization opportunities).

### `site:domain.com` URL fetch
```bash
curl -s -A "Mozilla/5.0 (compatible; SEO-Audit/1.0)" "https://www.google.com/search?q=site:example.com&num=100" | grep -oE 'https://example.com[^"&]*' | sort -u
```
Not a perfect signal (Google varies), but useful for spot-checks. **Note**: this can be rate-limited or block-listed; use sparingly.

## 3. JSON-LD cheat sheet (common types)

### Article
```json
{
  "@context": "https://schema.org",
  "@type": "Article",
  "headline": "Page title (max 110 chars)",
  "image": ["https://example.com/og-image.jpg"],
  "datePublished": "2024-01-15T08:00:00+00:00",
  "dateModified": "2024-12-01T12:00:00+00:00",
  "author": { "@type": "Person", "name": "Author Name", "url": "https://example.com/about/author" },
  "publisher": { "@type": "Organization", "name": "...", "logo": { "@type": "ImageObject", "url": "https://example.com/logo.png" } }
}
```

### Product
```json
{
  "@context": "https://schema.org",
  "@type": "Product",
  "name": "Product name",
  "image": "https://example.com/product.jpg",
  "description": "Short description",
  "sku": "1234",
  "brand": { "@type": "Brand", "name": "Brand name" },
  "offers": { "@type": "Offer", "priceCurrency": "USD", "price": "99.00", "availability": "https://schema.org/InStock", "url": "https://example.com/product" }
}
```

### Organization
```json
{
  "@context": "https://schema.org",
  "@type": "Organization",
  "name": "Company name",
  "url": "https://example.com",
  "logo": "https://example.com/logo.png",
  "sameAs": ["https://twitter.com/handle", "https://linkedin.com/company/..."]
}
```

### BreadcrumbList
```json
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    { "@type": "ListItem", "position": 1, "name": "Home", "item": "https://example.com" },
    { "@type": "ListItem", "position": 2, "name": "Blog", "item": "https://example.com/blog" },
    { "@type": "ListItem", "position": 3, "name": "Post title" }
  ]
}
```

### FAQPage
```json
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    { "@type": "Question", "name": "Q?", "acceptedAnswer": { "@type": "Answer", "text": "A." } }
  ]
}
```

### HowTo
```json
{
  "@context": "https://schema.org",
  "@type": "HowTo",
  "name": "How to do X",
  "step": [
    { "@type": "HowToStep", "name": "Step 1", "text": "..." },
    { "@type": "HowToStep", "name": "Step 2", "text": "..." }
  ]
}
```

Validate any of these at https://validator.schema.org/ before shipping.

## 4. Visibility verification checklist

After every fix, verify:

- [ ] `curl -A "Googlebot/2.1" https://example.com/sitemap.xml` returns valid XML
- [ ] `curl -A "Googlebot/2.1" https://example.com/robots.txt` doesn't disallow the page
- [ ] Page has unique `<title>` and `<meta name="description">` (not the homepage's)
- [ ] Page has `<link rel="canonical" href="...">` matching the desired URL
- [ ] JSON-LD parses (`JSON.parse` of all `<script type="application/ld+json">` blocks)
- [ ] PageSpeed Insights: performance score ≥ 90 mobile, ≥ 95 desktop
- [ ] Schema.org validator: pass for the schema types present
- [ ] Internal links to the page exist from at least 2 other indexable pages
- [ ] GSC paste-in: page shows impressions (if not, Google hasn't indexed yet — request indexing)

## 5. Common mistakes

- **Sitemap has 200 OK but no `<urlset>`** — file is empty or has HTML error wrapper. Always validate the XML.
- **Canonical points to a 404** — kills ranking. Always curl the canonical URL.
- **JSON-LD is in the `<head>` but with HTML comments around it** — most parsers handle this, but some don't. Test.
- **Multiple `<h1>` tags** — Google uses the first, but it's a smell. Use one.
- **404 pages in sitemap** — pulls down crawl budget. Audit with `grep -E "<loc>.*404|<loc>.*deleted"` after generation.
- **Schema uses `@type` typos** — `Product` is right, `product` is not. Schema.org is case-sensitive.
- **Sitemap submitted to GSC but URL is `noindex`** — pointless. Audit robots meta + X-Robots-Tag.

## 6. Verification commands cheat sheet

```bash
# Check canonical
curl -s https://example.com/page | grep -oE '<link rel="canonical"[^>]*>'

# Check robots directives
curl -s -A "Googlebot/2.1" https://example.com/page -I | grep -i "x-robots-tag\|x-powered-by"

# Check JSON-LD validity
curl -s https://example.com/page | grep -oP '(?<=<script type="application/ld\+json">).*?(?=</script>)' | jq .

# Check sitemap.xml is XML, not HTML error page
curl -sI https://example.com/sitemap.xml | head -1
curl -s https://example.com/sitemap.xml | head -3

# Check hreflang
curl -s https://example.com/page | grep -oE '<link rel="alternate" hreflang="[^"]*" href="[^"]*"'

# Check Open Graph + Twitter Card
curl -s https://example.com/page | grep -oE '<meta property="og:[^"]*" content="[^"]*"|<meta name="twitter:[^"]*" content="[^"]*"'
```

If you can't verify, say so in the Verdict block. Don't claim success without evidence.
