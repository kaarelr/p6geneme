# GitHub Pages

The workflow [`.github/workflows/pages.yml`](.github/workflows/pages.yml) deploys:

- `https://<user>.github.io/p6geneme/` — small index with links
- `https://<user>.github.io/p6geneme/trail-map/` — trail-map PWA
- `https://<user>.github.io/p6geneme/route-calculator/` — route-calculator (Vite build uses base path only when `CI=true`)

## One-time setup

1. Open **Settings → Pages** for this repository.
2. Under **Build and deployment**, set **Source** to **GitHub Actions** (not “Deploy from a branch”).

## Private repo + free GitHub account

**GitHub Pages does not run on private repositories with GitHub Free** (personal accounts). You will see HTTP 404 or a failed deploy until one of these is true:

- Make the **repository** public (the published site is public either way), or  
- Use **GitHub Pro** / Team / Enterprise, or  
- Host elsewhere (e.g. Cloudflare Pages, Netlify, Vercel) using the same build steps.

After Pages is allowed for the repo, re-run the failed workflow or push an empty commit:  
`git commit --allow-empty -m "chore: trigger pages deploy" && git push`

## Local production build (GitHub asset paths)

```bash
CI=true yarn workspace route-calculator build
```

Serve `_site` locally after running the same “Assemble site” steps as the workflow, or use `vite preview` only with matching base (CI build output is meant for `/p6geneme/route-calculator/`).

## Route calculator: ETAK pipeline on CI

The hosted map reads `route.geojson` from the Vite `public/` output. That file is produced by:

`etak:download` → `etak:graph` → `route:compute`

The Pages workflow runs these before `vite build`. `route-calculator/data/` is **gitignored** locally; on GitHub Actions a **cache** keyed on scripts + `config.ts` + lockfile avoids re-downloading ETAK on every push.

### Optional: `ETAK_BBOX` repository secret

Without it, `etak:download` requests all ETAK road features the WFS returns (all of Estonia), which can make the **first** workflow run very slow.

To restrict the bounding box, add a [repository secret](https://docs.github.com/en/actions/security-guides/using-secrets-in-github-actions#creating-secrets-for-a-repository) named `ETAK_BBOX` with a single value: **`minX,minY,maxX,maxY` in EPSG:3301**, same format as the WFS `BBOX` parameter (comma-separated numbers).
