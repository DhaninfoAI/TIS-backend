# TIS SmartFill: backend

AI QC service for the TIS Chrome extension (`../extension`). Implements the API in
`../extension/docs/BACKEND_REQUIREMENTS.md` (v0.2) plus sign-in, licences (photo plans) and the dashboard
(`../extension/docs/LICENSING.md`). Node ≥ 20, one dependency (`pg`). Started in the background it logs to
`data/server.log` / `data/server-error.log`. Known gaps and the improvement list: `../extension/docs/ROADMAP.md`.

```bash
npm install
npm start          # http://localhost:4010 · dashboard at /dashboard · API explorer at / · AI rules = admin tab in the dashboard (/rules forwards there)
npm run create-user -- --email you@company.com --role admin   # account on the running backend (asks for the password)
npm test           # photo clean-up (10) + photo claims (9) + renames (16) + pricing guide (43) + 22-order fixes (24) + end-to-end API (49) + sign-in/licences/seats/photo plans (39) + seat idle limit (7) + customer brand/platform (6); never touches Neon or OpenAI
npm run import-narratives   # re-import TIS's example narratives (../GPT_Narrative_Training.md) → rules/narrative-examples.json
npm run test:ai    # OpenAI code path against a fake OpenAI server (25 checks, no cost)
npm run eval       # full review of the 6 Boost AI sandbox orders → reports/eval-*.md (real engine, costs money)
```
Writer + page-helper checks (extension code, EZ markup replica): http://localhost:4010/writer-test (32 checks).
Panel / viewer preview without Chrome: `/ext/sidepanel/sidepanel.html?harness=1&order=1166305`,
`/ext/viewer/viewer.html?harness=1&order=1166305&view=photos|narrative`.

## The extension's API calls

Every call needs a signed-in person (`Authorization: Bearer <access token>`; `?token=` for photos and the stream),
or the developer token while `ALLOW_DEV_TOKEN` is on. Sign-in, licences, admin and dashboard routes: `../extension/docs/LICENSING.md`.

| API | Used for |
|---|---|
| `POST /v1/auth/login` · `/refresh` · `/logout` · `GET /v1/auth/me` | Sign-in, silent token renewal, sign-out |
| `GET /v1/health` | Online / Offline (every 20 s; open, `{ok:true}` for everyone but admins) |
| `PUT /v1/orders/{id}/snapshot` · `GET …/snapshot` | Send the order read from EZ (reply lists `photosNeeded`) · read it back |
| `POST /v1/orders/{id}/photos` | Upload photos (multipart, 6 per request, JPEG only) |
| `POST /v1/orders/{id}/analyses[?force=true]` | Start a review (returns the saved one when nothing changed, unless `force`) |
| `GET /v1/analyses/{id}/events` · `GET /v1/analyses/{id}` · `GET /v1/orders/{id}/analyses/latest` | Live progress (SSE) · result · latest result |
| `GET /v1/orders/{id}/photos/{imageId}[?token=]` · `…/insight` | Photo file · what the AI saw in it |
| `POST /v1/feedback` | Every Apply / Dismiss / Undo |
| `POST /v1/orders/{id}/qc-outcome` | Inspector feedback + every finding of the review with the reviewer's decision (`items[]`: applied / dismissed + reason / undone / not acted). The final-check route was removed 2026-11-10 |
| `POST /v1/orders/{id}/qc-outcome` | §6 flags, §7 rating, §8 note, applied/dismissed counts → `outcomes` (inspector analytics) |

Dashboard: `GET /v1/dashboard` (role decides the content), admin: `/v1/admin/orgs`, `/v1/admin/users`, `/v1/admin/plans`.
A review is refused with 402 `IMAGE_LIMIT` when the order's photos still to review exceed what is left of the plan's photos this month.
Not used by the extension yet: batches, `orders/status` (orders-list badges), rules API (admin-only; used by the dashboard's AI rules tab).
Admin-only: `/v1/analytics/summary`, cost estimate/compare. For the customer role the server removes AI usage, cost,
models, engines, fallback reasons and the score from every review response (`forClient` in `server.mjs`); for
everyone it removes the narrative rewrite and comment findings that older reviews still carry.

## Configuration: `.env` (gitignored; template in `.env.example`)

| Key | Meaning |
|---|---|
| `OPENAI_API_KEY` | Empty = practice (mock) mode. Set it to switch every AI step to OpenAI |
| `LLM_PROVIDER` | `openai` (default) or `mock` |
| `MODEL_PHOTO` / `MODEL_REASON` | Vision model / reasoning model (default `gpt-4o` / `gpt-4o`) |
| `PHOTO_DETAIL` | `high` (default) or `low` (cheaper, coarser) |
| `UNREVIEWED_PHOTO_HOURS` | Photos of an order opened but never reviewed are deleted after this many hours (default `24`, `0` = never). Reviewed orders keep theirs. Checked at start and every hour (`lib/photo-sweep.mjs`) |
| `MAX_COST_PER_ANALYSIS` | USD cap per review. Once reached, remaining AI steps fall back to practice mode |
| `DATABASE_URL` | Postgres (Neon). Empty → `data/state.json` |
| `DEV_TOKEN` / `ALLOW_DEV_TOKEN` | Developer token (acts as admin; tests, harness, eval). Set `ALLOW_DEV_TOKEN=0` for customers |
| `JWT_SECRET` | Signs access tokens. Empty → generated once and kept in the database |
| `BASE_PATH` | Path prefix when hosted under one, e.g. `/tis` for `https://dashboard.boost-usa.com/tis` (scopes the dashboard's sign-in cookie; requests with or without the prefix both work). Default: none |
| `HOST` | Address to listen on. `127.0.0.1` on a hosted server (only nginx can reach the app; the service file sets it). Default: all |
| `EXTENSION_DIR` | Where the extension folder is, for the developer previews only (`/ext/…` harness, `/writer-test`). Default `../extension`; not needed on a hosted server |
| `SEAT_IDLE_HOURS` | Hours without use before a computer's seat is freed (default 8; 0 = never) |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | First admin, created at start-up when no admin exists (remove the password afterwards) |

## How a review runs

`PUT snapshot` → `POST photos` (only new ones) → `POST analyses` → modules in this order, streamed over SSE:

| Module | Engine | Requirement served |
|---|---|---|
| orderBrief, checks, pricing, priorReport | Rule engine (`lib/rules.mjs`, `rules/*.json`) | Cross-field QC logic, final check |
| photoReview | OpenAI vision, 6 photos per call, cached per photo | Missed hazards (#1 value for TIS) |
| uwConcerns | OpenAI | Underwriter questions answered |
| recommendations | OpenAI + rules | **Recommendation** (add / rewrite / remove / merge) |
| recPhotos | OpenAI | **Recommendation photo addition** |
| questions | OpenAI + rules | **Yes or No questions** |
| captions | from vision results | **Renaming of images** |
| narrative | OpenAI (runs last) | **Narrative** check + draft (2026-11-06): TIS question set answers, ordered coverages to address in writing (GLOBAL-001), issues, and a draft in TIS style (2 closest example narratives); no-AI fallback checks the same by keyword |
| qcChecklist | derived | QC checklist §1–§8, rating |

All AI steps share one cached context (order rules pack + compact order + photo results), return strict
JSON, and cite evidence. Prompts are plain markdown in `prompts/`: edit and the next review uses them.
Notes saved in the dashboard's AI rules tab are appended to every prompt. If an AI step fails or hits the cost cap, it
falls back to the heuristic so the review always completes, and the result says so (`engine: "mock (fallback)"`).

## Files

```
server.mjs              routes, SSE, static dev pages
lib/store.mjs           Postgres (one JSONB table tisqc_docs) or file; write-through cache
lib/pipeline.mjs        module order + AI/mock selection + fallback
lib/ai-modules.mjs      OpenAI modules           lib/modules.mjs   heuristic (practice) modules
lib/llm.mjs             OpenAI client: structured outputs, retries, timeout, cost cap, usage
lib/rules.mjs           rule engine               lib/kb.mjs        client KB → per-order rules pack (+ TIS notes)
lib/cost.mjs, pricing.mjs  cost estimator + OpenAI token prices (2026-10-29). Not client pricing: see fees.mjs
lib/fees.mjs            client fee + inspector pay from TIS's pricing guide (rules/pricing.json)
lib/narrative.mjs       narrative question set, coverage rules, example picking (rules/narrative-*.json, coverage-rules.json)
prompts/*.md            AI instructions (editable)
rules/                  rules.json, form-registry.json, hazard_taxonomy.json, pricing.json (pricing guide V.10),
                        narrative-questions.json, narrative-examples.json, coverage-rules.json (global coverage rules v1.1)
lib/snapshot.mjs        field lookup helpers (form registry questions, narrative, overlap)
lib/auth.mjs            accounts, organisations + licences, access/refresh tokens, seats, scrypt passwords
lib/dashboard.mjs       dashboard figures: customer view and admin view (AI tokens, cost)
scripts/create-user.mjs create an account on a running backend
fixtures/               real captures of the 6 Boost AI orders (tests, eval and the preview harness)
data/photos/<order>/    photos uploaded by the extension (gitignored); unreviewed orders' folders removed after 24 h
public/                 dashboard.html, API explorer (index.html), rules editor, harness chrome.* stub, writer test page
scripts/eval.mjs        evaluation report → reports/ (gitignored, regenerate any time)
test/                   e2e.mjs (API), auth.mjs (sign-in, licences, roles), ai.mjs (+ fake-openai.mjs), photo-claims.mjs, renames.mjs,
                        fixtures/ (synthetic Seneca order)
```

Nothing is hard-coded per order: every review is computed from the snapshot. Saved data is input or cache only
(fixtures for demo/tests, uploaded photos, per-photo AI results, the last review per unchanged snapshot).

Data in Postgres: orgs (licences), users, sessions (hashed refresh tokens), snapshots, analyses (with token usage and $, orgId), feedback (every Apply / Dismiss / Undo from the
extension), QC outcomes, photo insights, rules + TIS notes + change log.

## Hosting

Server set-up (nginx + HTTPS + service + firewall) and the DNS record: [`deploy/DEPLOY.md`](deploy/DEPLOY.md).
