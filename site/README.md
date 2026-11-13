# toodo.dev

This folder contains the toodo.dev landing page: plain static HTML and CSS with no build step. The files served by Cloudflare Workers are in `public/`.

## Preview locally

From `site/public/`, run:

```sh
python3 -m http.server
```

Or run `npx wrangler dev` from `site/`.

## Deploy

For a manual deploy, run `npx wrangler login` once, then `npx wrangler deploy` from `site/`. This deploys the static assets and binds the `toodo.dev` custom domain.

Alternatively, connect the repository to Cloudflare Workers Builds, set the root directory to `site`, and use `npx wrangler deploy` as the deploy command. Deploy from the `main` branch.
