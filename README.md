# mini-tds

> 🌀 Minimal Cloudflare Worker-based Traffic Delivery Script (TDS)

Lightweight redirector running entirely on **Cloudflare Workers**, designed for
geo- and device-based traffic routing with a JSON configuration.  
Originally built for BookieRanks & LuckyLine projects.

---

## 💡 Overview

`mini-tds` intercepts only specific paths (e.g. `/casino/*`) and redirects
**mobile visitors from allowed countries** to an external URL pattern.
All other users (desktop, bots, crawlers, or disallowed countries) are
**passed through transparently** to the origin website — no 204s, no breakage.

---

## ✨ Key Features

- 🪶 **Ultra-light** — <10 KB Worker script, no dependencies.
- 🌍 **Geo + Device filters** (`cf.country` + UA parsing).
- 🤖 **Safe for SEO** — search engines (Yandex, Google, Bing, etc.)
  are fully whitelisted.
- 📱 **Mobile targeting** — detects iOS / Android / Windows Phone accurately,
  excluding tablets.
- ⚙️ **Declarative JSON config** — simple `config/routes.json` file defines rules.
- 🚦 **Transparent fallback** — non-matching requests are proxied to the origin.
- 🔗 **Dynamic query injection** — automatically passes path segments as parameters,
  e.g. `/casino/888starz` → `?bonus=888starz`.
- 📊 **Country / device / bot matchers** with optional tracking parameters.

---

## 🧩 Example Configuration

`config/routes.json`:

```json
{
  "rules": [
    {
      "id": "ru-mobile-casino-redirect",
      "match": {
        "path": ["/casino/*"],
        "countries": ["RU"],
        "devices": ["mobile"],
        "bot": false
      },
      "target": "https://2win.click/tds/go.cgi?4",
      "status": 302,
      "forwardQuery": false,
      "appendPath": false,
      "extraParams": {
        "__pathToParam": "bonus",
        "__stripPrefix": "/casino/"
      },
      "trackingParam": "src",
      "trackingValue": "mobile-geo"
    }
  ]
}
```



---

## 🧾 Changelog

### v1.2 · November 2025
**Major update — safe redirect logic & transparent proxy**

- 🚫 Removed legacy `fallback: 204` behavior  
  → Non-matching requests are now transparently proxied to the origin via `fetch(request)`.
- 🤖 Added full **bot whitelist** (Yandex, Google, Bing, DuckDuckGo, etc.)  
  → Crawlers never trigger redirects — SEO-safe.
- 📱 Reworked **mobile detector**:
  - Correctly identifies Android/iOS phones  
  - Excludes tablets and desktop browsers  
  - Handles tricky cases like iPadOS and masked Safari UAs
- 🌍 Improved **country and device matching** logic.
- 🧩 Added dynamic `__pathToParam` + `__stripPrefix` options  
  → Automatically maps `/casino/<slug>` → `?bonus=<slug>`.
- ⚙️ Redirects now trigger **only** for `GET` requests.
- 🪶 Cleaned up types and simplified config schema (`routes.json`).

---

### v1.1 · September 2025
- Added JSON-based route config (`config/routes.json`)
- Introduced country/device/bot filters
- Added extraParams, tracking params, and appendPath support
- Initial deployable Cloudflare Worker

---

### v1.0 · July 2025
- Initial release of `mini-tds`  
- Basic redirect logic with single hardcoded rule  
- Early test version for BookieRanks project

