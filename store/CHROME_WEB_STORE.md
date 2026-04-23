# Chrome Web Store — listing & packaging checklist

Official image specifications: [Supplying images](https://developer.chrome.com/docs/webstore/images)  
Publishing flow: [Publish in the Chrome Web Store](https://developer.chrome.com/docs/webstore/publish)  
Host permissions & review notes: **`PERMISSIONS_AND_REVIEW.md`** in this folder.

## Image assets (this folder)

| Requirement | Size | File here | Notes |
|-------------|------|-----------|--------|
| **Extension icon** (in ZIP + listing) | **128×128** PNG | `icons/icon128.png` (manifest) + **`icon-128-listing.png`** here | Google recommends artwork ~**96×96** centered with **transparent** padding in the 128×128 canvas. `icon-128-listing.png` follows that for dashboard upload; keep manifest icons under `icons/`. |
| **Small promo tile** (required) | **440×280** | `promo-small-440x280.png` | Upload in **Promotional images**. Avoid tiny text; works on light gray background. |
| **Screenshot(s)** (required, up to 5) | **1280×800** *or* **640×400** | `screenshot-01-1280x800.png` | Full bleed, square corners. Prefer **1280×800**. Replace with **real captures** of your popup before release so the listing matches the product. |
| **Marquee** (optional) | **1400×560** | `promo-marquee-1400x560.png` | Improves featuring eligibility. |

### Rebuild listing PNGs from sources

Source art (editable) lives in `store/sources/`. Install Python deps once, then rebuild:

```bash
cd store
pip3 install -r requirements.txt
python3 build_assets.py
```

## Other common Store requirements (not files)

- **Developer account**: one-time registration in the Chrome Web Store Developer Program.
- **ZIP package**: zip the **extension root** (must include `manifest.json`, `popup.html`, `popup.js`, `style.css`, `icons/`, …) — not this `store/` folder alone.
- **Single purpose** / **permission justification**: cite the **exact** `api-web.nhle.com` paths from `manifest.json` (see **`PERMISSIONS_AND_REVIEW.md`** for sample text).
- **Privacy practices questionnaire**: accurate answers; if you collect no data, state that clearly.
- **Privacy policy URL**: required when the questionnaire indicates you handle user data or certain APIs; many read-only extensions still host a short policy page (GitHub Pages, etc.).
  - This repo includes **`privacy/index.html`**. Enable **GitHub Pages** on the repo (**Settings → Pages → Deploy from a branch → `/ (root)`** on `main`), then use  
    `https://<your-username>.github.io/<repository-name>/privacy/`  
    in the Store (example: `https://evgenig-io.github.io/nhl-playoff-tracker/privacy/`). See the root **README** for the full steps.
- **Branding**: if you show NHL or team marks in screenshots, follow [Chrome Web Store branding](https://developer.chrome.com/docs/webstore/branding) and league/trademark rules.

## Before you publish

1. Capture **real** screenshots at **1280×800** (or 640×400) from Chrome with your popup open.
2. Add up to **four more** screenshots (`screenshot-02-…` etc.) in the dashboard if you want the full five.
3. Replace or adjust promo art if review rejects generic tiles.
4. Bump `manifest.json` **version** for each submission.
