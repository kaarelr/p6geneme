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

### Route API + `ROUTE_API_URL` secret

The hosted route calculator can **recompute** and **rebuild the graph** from the browser when a backend is deployed and the static build knows its URL. Deploy the API with **Railway**, **Render**, or **Fly** using the scripts in the root [`package.json`](package.json) (`build:api`, `start:api`); no container files live in this repo.

`route-calculator/data/` is **gitignored** — you must still provide `graph.bin` and ETAK inputs on the server: bake into the deploy artifact, **Fly Volume** + upload, object storage + download on boot, or run the ETAK pipeline in CI and ship the `data/` tree with the release.

#### Railway or Render (simplest)

Use the **monorepo root** (where the root `package.json` and `yarn.lock` live).

| Setting | Value |
|--------|--------|
| Install | `yarn install --frozen-lockfile` |
| Build | `yarn build:api` (or `yarn build` — same) |
| Start | `yarn start:api` (or `yarn start` — same) |
| Env | `DATA_ROOT` = absolute path to the **`route-calculator`** directory inside the runtime (the folder that contains `data/graph.bin`), `PORT` from the platform, `CORS_ORIGINS` = `https://<user>.github.io` |

#### Fly.io (Paketo buildpacks)

[`fly.toml`](fly.toml) lives at the **repo root** and uses `builder = "paketobuildpacks/builder-jammy-base"`.

##### Initial Fly setup (once, on your machine)

1. **Install the Fly.io CLI** (macOS): `brew install flyctl` — or see [Install flyctl](https://fly.io/docs/hands-on/install-flyctl/).  
   **Do not** run `brew install fly` — that installs **Concourse’s** unrelated `fly` binary and can block `flyctl` from linking. If you installed it by mistake: `brew uninstall --cask fly` then `brew link --overwrite flyctl`. The `fly` command should then run Fly.io (`fly version` shows a Fly.io build).
2. **Sign in:** `fly auth login` (opens a browser).
3. **Create the app** if it does not exist yet (name must match `app` in [`fly.toml`](fly.toml), default `p6geneme-route-api`):
   - `fly apps create p6geneme-route-api --org personal`  
   - Or run `fly launch --no-deploy` from the repo root and accept or edit the app name so it matches `fly.toml`.
4. **Configure secrets** (replace `<user>` with your GitHub username; adjust `DATA_ROOT` if Paketo uses a different layout on your builder):
   ```bash
   cd /path/to/p6geneme
   fly secrets set CORS_ORIGINS="https://<user>.github.io" -a p6geneme-route-api
   fly secrets set DATA_ROOT="/workspace/route-calculator" -a p6geneme-route-api
   ```
5. **First deploy from your laptop** (optional but good to verify before CI): ensure `route-calculator/data/` exists (run `yarn etak:download`, `yarn etak:graph`, `yarn route:compute` locally or rely on the same cache story as CI), then:
   ```bash
   fly deploy -a p6geneme-route-api
   ```
6. If the API cannot find `graph.bin`, open a shell: `fly ssh console -a p6geneme-route-api`, run `pwd` / `ls`, and fix `DATA_ROOT` with `fly secrets set DATA_ROOT="..."`.

##### GitHub Actions: deploy Fly automatically

Workflow: [`.github/workflows/fly-deploy.yml`](.github/workflows/fly-deploy.yml).

1. **Create a deploy token** (local): `fly tokens create deploy -x 999999h` or from the [Fly dashboard tokens page](https://fly.io/user/personal/tokens).
2. In the GitHub repo: **Settings → Secrets and variables → Actions → New repository secret** — name **`FLY_API_TOKEN`**, value = the token.
3. Optional: reuse **`ETAK_BBOX`** (same as Pages) so the first `etak:download` in CI is bounded.
4. Trigger a run: push to `master` that touches the paths listed in the workflow, or **Actions → Deploy Fly API → Run workflow**.

The workflow runs the same ETAK download → graph → route steps as Pages (with the same `route-calculator/data` cache), then **`flyctl deploy --remote-only`** so the image is built on Fly’s builders.

#### GitHub Pages client (`ROUTE_API_URL`)

After the Fly API is deployed, point the static site at it:

1. Add a repository secret **`ROUTE_API_URL`** with the API origin only (no path, no trailing slash), e.g. `https://p6geneme-route-api.fly.dev` (from `fly apps list` or the Fly dashboard).
2. Re-run the Pages workflow so `yarn workspace route-calculator build` receives `VITE_API_URL` and bundles it into the client.

If `ROUTE_API_URL` is unset, the map still loads `route.geojson` from Pages; API buttons will fail until the secret is set.

### Optional: `ETAK_BBOX` repository secret

Without it, `etak:download` requests all ETAK road features the WFS returns (all of Estonia), which can make the **first** workflow run very slow.

To restrict the bounding box, add a [repository secret](https://docs.github.com/en/actions/security-guides/using-secrets-in-github-actions#creating-secrets-for-a-repository) named `ETAK_BBOX` with a single value: **`minX,minY,maxX,maxY` in EPSG:3301**, same format as the WFS `BBOX` parameter (comma-separated numbers).
