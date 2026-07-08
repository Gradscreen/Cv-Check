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

## 2. Configure

Copy `.env.example` to `.env` and fill in:

```
ANTHROPIC_API_KEY=your key from step 1
STAFF_PASSWORD=a real password, not "changeme"
SESSION_SECRET=a random string — generate with:
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
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

## Notes on privacy and safety

- By default, only the **extracted text and AI analysis** are stored — not
  the original CV file — to limit how much personal data you're holding.
- Consider adding a data retention policy (e.g. a scheduled job that deletes
  submissions older than 90 days) if this will run continuously.
- The submission form requires a consent checkbox before processing — update
  the wording to match your institution's actual privacy policy.
- Submissions are rate-limited (8 per hour per device) to prevent abuse and
  runaway API costs. Adjust `submitLimiter` in `server.js` if needed.
- This gives a **basic first-pass score** — treat it as a triage tool, not a
  final decision-maker, especially for anything that affects a real student's
  opportunities.

## Going further

- Swap the JSON file for a real database (e.g. Postgres) if you expect high
  volume or need multiple staff accounts.
- Add per-staff logins instead of one shared password if more than one
  person needs access with individual accountability.
- Email the score to the student automatically (e.g. via a service like
  Resend or SendGrid) instead of only showing it on screen.
