# toodo.dev

This folder contains the toodo.dev landing page: plain static HTML and CSS with no build step. The files served by Cloudflare Workers are in `public/`.

## Preview locally

From `site/public/`, run:

```sh
python3 -m http.server
```

Or run `npx wrangler dev` from `site/`.

## Deploy

The `Site` workflow (`.github/workflows/site.yml`) deploys on every push to `dev` that touches `site/`, and can be run by hand from the Actions tab. It reads the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repository secrets; the token needs Workers Scripts edit on the account and Workers Routes and DNS edit on the `toodo.dev` zone.

For a manual deploy, run `npx wrangler login` once (or set `CLOUDFLARE_API_TOKEN`), then `npx wrangler deploy` from `site/`. This deploys the static assets and binds the `toodo.dev` and `www.toodo.dev` custom domains.
