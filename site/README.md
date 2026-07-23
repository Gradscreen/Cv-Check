# GradScreen

A small website: a marketing homepage, a CV enquiry form with instant
AI-generated feedback, and a password-protected staff dashboard.

- `public/index.html` — the marketing homepage
- `public/enquire.html` — the CV enquiry form, linked from the homepage
- `public/dashboard.html` — staff-only view of all submissions
- `public/privacy.html` — privacy policy
- `server.js` — the backend: handles uploads, calls the Anthropic API, stores results
- `data/submissions.json` — where results are stored (created automatically)

## Pointing your root domain at this site

Your `gradscreen.com` may currently point to GoDaddy's own Website Builder
product. To make `gradscreen.com` show this site instead:

1. In Render, open your service → **Settings** → **Custom Domains** → **Add
   Custom Domain**, and enter `gradscreen.com` (the bare/apex domain)
2. Render will show you a DNS record to add — for an apex domain this is
   usually an **A record** pointing at an IP Render provides (follow exactly
   what Render's UI shows)
3. In GoDaddy → DNS Records, delete the existing `A` record on `@` (the
   "WebsiteBuilder Site" one) once you're happy replacing it, and add the new
   `A` record Render gave you
4. Your existing `www` CNAME doesn't need to change

Alternatively, you can keep GoDaddy's Website Builder as your homepage and
just add a button linking out to `https://cv-check.gradscreen.com/enquire.html`
(or wherever this app is hosted) — no DNS changes needed for that approach.

**Before pointing real traffic at it:** `public/index.html` has
`[placeholder]` copy in a few spots — replace it with real copy about what
GradScreen actually offers.

## 1. Get an Anthropic API key

This app calls Claude's API directly from your own server, so you need your
own API key — separate from your claude.ai account:

1. Go to https://console.anthropic.com and sign up / log in
2. Add billing (pay-as-you-go; CV scoring costs a fraction of a cent per CV)
3. Create an API key under **Settings > API Keys**

## 1b. Get an email alert key (Resend)

Every enquiry emails your team automatically via [Resend](https://resend.com):

1. Sign up at resend.com (free tier covers small volume easily)
2. Create an API key under **API Keys**
3. Verify your own domain under **Domains** so you can send from an address
   like `enquiries@gradscreen.com` — Resend will show you DNS records
   (typically an MX and two TXT records) to add in GoDaddy. Until verified,
   you can test with the shared address `onboarding@resend.dev`.

## 2. Configure

Copy `.env.example` to `.env` and fill in the values described inline —
your Anthropic key, a real staff password, a random session secret, your
Resend key, your company inbox, and your verified from-address.

**Never** commit `.env` to git or put the API key anywhere in the `public/`
folder — it must only live on the server.

## 3. Run it locally to test

```
npm install
npm start
```

Visit `http://localhost:3000` for the homepage, `/enquire.html` for the CV
form, and `/dashboard.html` for the staff view.

## 4. Deploy it

1. Push this project to a GitHub repo
2. On [Render](https://render.com), **New > Web Service**, connect the repo
3. Build command: `npm install` — Start command: `npm start`
4. Add all the environment variables from `.env.example` under
   **Environment**
5. Deploy — you'll get a URL like `cv-check.onrender.com`

## Data persistence — do this before real traffic

By default, submissions are stored in a JSON file inside the app folder,
which is **wiped on every redeploy** on most hosts, including Render. Fix
this once you're past testing:

1. In Render, open your service → **Disks** → **Add Disk**, mount path
   `/var/data` (requires a paid Render plan with disk support)
2. In **Environment**, set `DATA_DIR=/var/data`
3. Redeploy — submissions now survive redeploys and restarts

Stored CV files live under `DATA_DIR/files`, so they need the same disk.

## Spam protection

Three layers:

1. **Rate limiting** — max 25 submissions/hour per device (loosened from a
   stricter default since students on shared campus/library WiFi can share
   one IP address)
2. **Honeypot + timing checks** — always on, no setup needed
3. **Cloudflare Turnstile** (optional, recommended once public) — get a free
   site + secret key at dash.cloudflare.com → Turnstile, add them as
   `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET_KEY` in Render. The widget
   appears on the form automatically once both are set.

## Privacy policy

`public/privacy.html` is a **starting template**, not legal advice — full of
`[bracketed placeholders]` to fill in, and it should be reviewed by a
solicitor before publishing, particularly around UK GDPR. It's linked from
the consent checkbox on the enquiry form, and states the service is for
users 18+ (enforced by a required checkbox on the form, checked server-side
too).

## Notes on privacy and safety

- The original CV file is stored (so staff can download it from the
  dashboard) but automatically deleted 90 days after submission — only the
  AI analysis and extracted text are kept after that. Adjust
  `FILE_RETENTION_DAYS` in `server.js` for a different window.
- Every submission emails both your team and the student a confirmation, via
  Resend.
- If AI analysis fails for any reason, the enquiry is still saved and
  emailed to your team (flagged for manual review) so nothing gets lost.
- This gives a **basic first-pass score** — treat it as a triage tool, not a
  final decision-maker.

## Swapping in real photography

The background art is a small tiled pattern of icons drawn in code — no
photo license needed. To swap in licensed photos later, see the
`ARTWORK SWAP POINT` comments in each page's CSS and HTML.

## Going further

- Swap the JSON file for a real database if you expect high volume
- Add per-staff logins instead of one shared password
- CSV export / search on the dashboard
