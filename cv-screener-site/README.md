# CV Check

A small website: students upload a CV, get an instant AI-generated score and
feedback, and staff can review all submissions on a password-protected
dashboard.

- `public/index.html` — the student-facing form (this is your homepage)
- `public/dashboard.html` — staff-only view of all submissions
- `server.js` — the backend: handles uploads, calls the Anthropic API, stores results
- `data/submissions.json` — where results are stored (created automatically)

## 1. Get an Anthropic API key

This app calls Claude's API directly from your own server, so you need your
own API key — separate from your claude.ai account:

1. Go to https://console.anthropic.com and sign up / log in
2. Add billing (this is pay-as-you-go; CV scoring is cheap — roughly a fraction
   of a cent per CV with the model used here)
3. Create an API key under **Settings > API Keys**

## 1b. Get an email alert key (Resend)

Every enquiry emails your team automatically via [Resend](https://resend.com):

1. Sign up at resend.com (free tier covers small volume easily)
2. Create an API key under **API Keys**
3. For quick testing, you can send from Resend's shared address
   `onboarding@resend.dev` with no extra setup. To send from your own domain
   (e.g. `enquiries@yourcompany.com`), verify it under **Domains** in Resend —
   they'll give you DNS records to add in GoDaddy, similar to the CNAME step
   in section 4 below.

If you skip this, the app still works — it just won't send email alerts, and
you'd rely on the staff dashboard alone to see new enquiries.

## 2. Configure

Copy `.env.example` to `.env` and fill in:

```
ANTHROPIC_API_KEY=your key from step 1
STAFF_PASSWORD=a real password, not "changeme"
SESSION_SECRET=a random string — generate with:
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
RESEND_API_KEY=your key from step 1b
COMPANY_EMAIL=the inbox that should get new-enquiry alerts
FROM_EMAIL=onboarding@resend.dev (or your verified domain address)
```

**Never** commit `.env` to git or put the API key anywhere in the `public/`
folder — it must only live on the server.

## 3. Run it locally to test

```
npm install
npm start
```

Visit `http://localhost:3000` for the student form, and
`http://localhost:3000/dashboard.html` for the staff view.

## 4. Deploy it somewhere

A GoDaddy domain by itself is just a name — it doesn't run Node.js apps
(GoDaddy's own hosting is typically shared cPanel hosting, which usually
can't run a persistent Node server like this one). The simplest path:

1. **Host the app** on a service built for this, e.g. [Render](https://render.com)
   or [Railway](https://railway.app). Both have a free/cheap tier, both let
   you connect a GitHub repo and deploy in a few clicks, and both let you set
   environment variables (your `.env` values) in their dashboard rather than
   a file.
2. Once deployed, you'll get a URL like `cv-check.onrender.com`.
3. **Point your GoDaddy domain at it**: in GoDaddy's DNS settings for your
   domain, add a CNAME record (e.g. `cv.yourdomain.com` → `cv-check.onrender.com`),
   or check your hosting provider's docs for connecting a custom domain —
   Render and Railway both have a "Custom Domain" setting that will tell you
   exactly which DNS record to add.

## Swapping in real photography

The background art is currently a small tiled pattern of icons (caps, books,
scrolls) drawn directly in code — no photo license needed. If you get
licensed photos later (your own campus, students who've consented to be
featured, or licensed stock), here's how to swap it in, in both
`public/index.html` and `public/dashboard.html`:

1. Add your image file to `public/images/` — e.g. `public/images/campus.jpg`
2. In the `<head>`/CSS section, find the comment block labelled
   **"ARTWORK SWAP POINT"**. Uncomment the `.bg-photo` rule just below it,
   and update the filename in `background-image:url('images/campus.jpg')`
   if you named it differently.
3. In the HTML body, find the matching **"ARTWORK SWAP POINT"** comment.
   Delete the `<svg class="bg-pattern">...</svg>` block and replace it with:
   ```html
   <div class="bg-photo"></div>
   ```
4. Redeploy. The photo will sit behind the content with a soft tint overlay
   (matching the current background color) so text stays readable — adjust
   the opacity values in `.bg-photo::after` if you want the photo more or
   less visible.

Only use images you actually have the rights to — your own photography,
stock with an appropriate license, or photos of students/staff who've given
explicit consent to be used on the site.

## Data persistence — do this before real traffic

By default, submissions are stored in a JSON file inside the app folder.
On Render (and most hosts), that file is **wiped on every redeploy** —
including automatic ones triggered by a GitHub push. Fix this once:

1. In Render, open your service → **Disks** → **Add Disk**
2. Give it a name, size (1GB is plenty to start), and set the **Mount Path**
   to `/var/data`
3. In **Environment**, set `DATA_DIR=/var/data`
4. Redeploy. From now on, submissions survive redeploys and restarts.

(This requires a paid Render plan with disk support — free-tier services
don't support persistent disks. If you outgrow this approach, migrate to a
real hosted database like Render's managed Postgres.)

## Spam protection

Three layers, from "always on" to "optional but stronger":

1. **Rate limiting** — max 8 submissions/hour per device, already built in.
2. **Honeypot + timing checks** — a hidden field bots tend to fill in, and a
   rejection of any submission completed in under 2.5 seconds. No setup
   needed, already active.
3. **Cloudflare Turnstile** (optional, recommended once this is public) —
   a free, invisible CAPTCHA:
   1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → **Turnstile**
   2. Add a site, using your real domain
   3. Copy the **Site Key** and **Secret Key** into Render's environment as
      `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`
   4. Redeploy — the widget appears on the form automatically once both keys
      are set, with no code changes needed.

## Privacy policy

`public/privacy.html` is a **starting template**, not real legal advice —
it's full of `[bracketed placeholders]` you need to fill in, and it should
be reviewed by a solicitor before you publish it, particularly around UK
GDPR since you may be handling data from under-18s. It's already linked
from the consent checkbox on the enquiry form.

## Notes on privacy and safety

- By default, only the **extracted text and AI analysis** are stored — not
  the original CV file — to limit how much personal data you're holding.
- Every submission triggers a confirmation email to the student as well as
  an alert to your team — both via Resend, using the same keys.
- Consider adding a data retention policy (e.g. a scheduled job that deletes
  submissions older than 90 days) if this will run continuously — and say
  what that period actually is in `privacy.html`.
- The submission form requires a consent checkbox linking to `privacy.html`
  — fill in that template with your real policy before going live.
- Submissions are rate-limited (8 per hour per device), plus honeypot/timing
  checks and optional Turnstile, to prevent abuse and runaway API costs.
- This gives a **basic first-pass score** — treat it as a triage tool, not a
  final decision-maker, especially for anything that affects a real student's
  opportunities. If AI analysis fails for any reason, the enquiry is still
  saved and emailed to your team so nothing gets lost.

## Going further

- Swap the JSON file for a real database (e.g. Postgres) if you expect high
  volume or need multiple staff accounts.
- Add per-staff logins instead of one shared password if more than one
  person needs access with individual accountability.
- Email the score to the student automatically (e.g. via a service like
  Resend or SendGrid) instead of only showing it on screen.
