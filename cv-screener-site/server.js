require('dotenv').config();
const express = require('express');
const multer = require('multer');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const mammoth = require('mammoth');
const Anthropic = require('@anthropic-ai/sdk');
const { Resend } = require('resend');

const app = express();
const PORT = process.env.PORT || 3000;
// DATA_DIR should point at a Render persistent disk mount (e.g. /var/data) in
// production — otherwise submissions are wiped on every redeploy. See README.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'submissions.json');
const FILES_DIR = path.join(DATA_DIR, 'files');
const FILE_RETENTION_DAYS = 90; // original CVs are deleted after this; the AI analysis/summary is kept
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'changeme';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const MAX_FILE_BYTES = 4 * 1024 * 1024; // 4MB
const MIN_FILL_TIME_MS = 2500; // reject submissions filled in suspiciously fast

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('WARNING: ANTHROPIC_API_KEY is not set. CV analysis will fail until you add it to .env');
}
if (STAFF_PASSWORD === 'changeme') {
  console.warn('WARNING: STAFF_PASSWORD is using the default value. Set a real password in .env before going live.');
}
if (process.env.DATA_DIR === undefined) {
  console.warn('WARNING: DATA_DIR is not set — using local ./data, which is wiped on every redeploy on most hosts. See README "Data persistence".');
}
if (!process.env.TURNSTILE_SECRET_KEY) {
  console.warn('NOTE: TURNSTILE_SECRET_KEY is not set — relying on honeypot/timing checks only for spam protection. See README "Spam protection" to add Cloudflare Turnstile.');
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
if (!resend) {
  console.warn('WARNING: RESEND_API_KEY is not set. New-enquiry email alerts will be skipped.');
}
if (!process.env.COMPANY_EMAIL) {
  console.warn('WARNING: COMPANY_EMAIL is not set. New-enquiry email alerts will be skipped.');
}

// --- tiny JSON file "database" -------------------------------------------
// Fine for small/medium volume. Swap for a real database later if you need
// concurrent writes at scale or multi-server deployment. MUST live on a
// persistent disk in production or it's wiped on every redeploy.
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(FILES_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]');

function readSubmissions() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
}
function writeSubmissions(list) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2));
}

// Delete stored CV files older than FILE_RETENTION_DAYS. The analysis/summary
// text is kept — only the original document is removed.
function cleanupOldFiles() {
  const all = readSubmissions();
  const cutoff = Date.now() - FILE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let changed = false;
  for (const record of all) {
    if (record.storedFileName && new Date(record.submittedAt).getTime() < cutoff) {
      const filePath = path.join(FILES_DIR, record.storedFileName);
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch (e) { console.error('Could not delete old file:', e.message); }
      }
      record.storedFileName = null;
      record.fileDeletedAt = new Date().toISOString();
      changed = true;
    }
  }
  if (changed) writeSubmissions(all);
}
cleanupOldFiles();
setInterval(cleanupOldFiles, 24 * 60 * 60 * 1000);

// --- middleware ------------------------------------------------------------
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.set('trust proxy', 1); // needed for correct rate-limiting behind Render/Railway/etc proxies
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
    secure: process.env.NODE_ENV === 'production'
  }
}));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
  fileFilter: (req, file, cb) => {
    const ok = [
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain'
    ].includes(file.mimetype);
    cb(ok ? null : new Error('Only PDF, DOCX, or TXT files are accepted'), ok);
  }
});

// Basic abuse protection — tune to your expected traffic. Kept fairly loose
// because many students may share one IP (campus WiFi, library networks).
const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 25,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many submissions from this network. Please try again in an hour.' }
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' }
});

// --- spam protection: Cloudflare Turnstile (optional, off unless configured) --
app.get('/api/config', (req, res) => {
  res.json({ turnstileSiteKey: process.env.TURNSTILE_SITE_KEY || null });
});

async function verifyTurnstile(token, ip) {
  if (!process.env.TURNSTILE_SECRET_KEY) return true; // not configured — skip
  if (!token) return false;
  try {
    const resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: process.env.TURNSTILE_SECRET_KEY, response: token, remoteip: ip || '' })
    });
    const data = await resp.json();
    return !!data.success;
  } catch (err) {
    console.error('Turnstile verification failed:', err.message);
    return false;
  }
}

// --- CV analysis -----------------------------------------------------------
async function buildContentBlock(file) {
  const ext = file.originalname.toLowerCase().split('.').pop();
  if (ext === 'pdf') {
    return {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: file.buffer.toString('base64') }
    };
  } else if (ext === 'docx') {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    return { type: 'text', text: result.value };
  } else {
    return { type: 'text', text: file.buffer.toString('utf-8') };
  }
}

const SYSTEM_PROMPT = `You are a basic CV screening assistant helping students understand how their CV comes across for a target role or programme. Given a candidate's CV and a target description, extract key facts and score the CV's fit.

Respond with ONLY a raw JSON object, no markdown fences, no preamble, matching exactly this shape:
{
  "name": "string, candidate's full name or 'Not found'",
  "email": "string or empty",
  "phone": "string or empty",
  "years_experience": "string, e.g. '2 years' or 'Not stated'",
  "education": ["short strings"],
  "skills": ["short skill tags, max 8"],
  "summary": "2-3 sentence neutral summary of the candidate's background",
  "score": 0,
  "strengths": ["short bullet points relative to the target, max 4"],
  "gaps": ["short constructive bullet points on what could be improved, max 4"]
}

Scoring guidance: score is 0-100 reflecting fit against the target (not general CV quality). If no target was given, score general CV strength instead and note that in the summary. Keep gaps constructive and actionable — this may be shown directly to the student.`;

async function analyzeCV(contentBlock, target) {
  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 1000,
    system: SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: [
        contentBlock,
        {
          type: 'text',
          text: `Target role/programme:\n${target || '(none provided — assess general CV strength)'}\n\nRespond with the JSON object only.`
        }
      ]
    }]
  });
  const textBlock = msg.content.find(b => b.type === 'text');
  if (!textBlock) throw new Error('No response from the AI');
  const clean = textBlock.text.trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
  return JSON.parse(clean);
}

async function sendEnquiryAlert(record) {
  if (!resend || !process.env.COMPANY_EMAIL) return;
  const d = record.analysis;
  const strengths = d ? (d.strengths || []).map(s => `<li>${escapeHtml(s)}</li>`).join('') : '';
  const gaps = d ? (d.gaps || []).map(s => `<li>${escapeHtml(s)}</li>`).join('') : '';
  const skills = d ? (d.skills || []).map(s => escapeHtml(s)).join(', ') : '';

  const analysisBlock = d ? `
    <h3>AI screening summary (score: ${d.score ?? 'n/a'}/100)</h3>
    <p>${escapeHtml(d.summary || '')}</p>
    <p><strong>Skills:</strong> ${skills || 'None extracted'}</p>
    <p><strong>Strengths:</strong></p><ul>${strengths || '<li>None listed</li>'}</ul>
    <p><strong>Gaps:</strong></p><ul>${gaps || '<li>None listed</li>'}</ul>
  ` : `
    <h3 style="color:#A6432F;">AI analysis unavailable</h3>
    <p>The automatic CV screening didn't complete for this enquiry (${escapeHtml(record.analysisError || 'unknown error')}). Please review the attached CV details manually in the dashboard.</p>
  `;

  const html = `
    <h2>New enquiry: ${escapeHtml(record.studentName)}</h2>
    <p>
      <strong>Email:</strong> ${escapeHtml(record.studentEmail)}<br>
      <strong>Phone:</strong> ${escapeHtml(record.phone || 'Not provided')}<br>
      <strong>Interested in:</strong> ${escapeHtml(record.target || 'Not specified')}<br>
      <strong>Heard about us via:</strong> ${escapeHtml(record.referral || 'Not specified')}
    </p>
    ${record.message ? `<p><strong>Message:</strong><br>${escapeHtml(record.message)}</p>` : ''}
    <hr>
    ${analysisBlock}
    <hr>
    <p style="color:#666;font-size:12px;">Full details and CV history are in the staff dashboard.</p>
  `;

  try {
    await resend.emails.send({
      from: process.env.FROM_EMAIL || 'onboarding@resend.dev',
      to: process.env.COMPANY_EMAIL,
      subject: `New enquiry: ${record.studentName}${d ? ` (score ${d.score ?? 'n/a'})` : ' (needs manual review)'}`,
      html
    });
  } catch (err) {
    console.error('Failed to send enquiry alert email:', err.message);
    // Don't let an email failure break the student's submission
  }
}

async function sendStudentConfirmation(record) {
  if (!resend) return;
  const d = record.analysis;
  const scoreBlock = d ? `
    <hr>
    <h3>Your CV, at a glance (score: ${d.score ?? 'n/a'}/100)</h3>
    <p>${escapeHtml(d.summary || '')}</p>
  ` : `
    <hr>
    <p>We weren't able to generate instant feedback on your CV this time, but don't worry — your enquiry and CV have been received, and an adviser will look at it personally.</p>
  `;

  const html = `
    <h2>Thanks, ${escapeHtml(record.studentName)} — we've got your enquiry</h2>
    <p>One of our advisers will follow up with you personally${record.target ? ` about ${escapeHtml(record.target)}` : ''}. In the meantime, here's a quick recap:</p>
    ${scoreBlock}
    <hr>
    <p style="color:#666;font-size:12px;">If you didn't submit this enquiry, you can ignore this email.</p>
  `;

  try {
    await resend.emails.send({
      from: process.env.FROM_EMAIL || 'onboarding@resend.dev',
      to: record.studentEmail,
      subject: `We've got your enquiry — GradScreen`,
      html
    });
  } catch (err) {
    console.error('Failed to send student confirmation email:', err.message);
  }
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
app.post('/api/submit', submitLimiter, (req, res) => {
  upload.single('cv')(req, res, async (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'File is too large — please use a file under 4MB.'
        : (err.message || 'Upload failed');
      return res.status(400).json({ error: msg });
    }
    try {
      const { name, email, phone, target, message, referral, consent, ageConfirm, website, formLoadedAt, 'cf-turnstile-response': turnstileToken } = req.body;

      // --- spam checks (fail quietly, as if nothing happened — don't tip off bots) ---
      if (website) { // honeypot field — real users never fill this in
        return res.json({ ok: true, analysis: null });
      }
      if (formLoadedAt && (Date.now() - Number(formLoadedAt)) < MIN_FILL_TIME_MS) {
        return res.json({ ok: true, analysis: null });
      }
      const turnstileOk = await verifyTurnstile(turnstileToken, req.ip);
      if (!turnstileOk) {
        return res.status(400).json({ error: 'Spam check failed — please try again.' });
      }

      if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });
      if (ageConfirm !== 'true') return res.status(400).json({ error: 'Please confirm you are 18 or over to submit' });
      if (consent !== 'true') return res.status(400).json({ error: 'Please confirm consent to processing before submitting' });
      if (!req.file) return res.status(400).json({ error: 'No CV file uploaded' });

      // --- save the original file to disk (kept for FILE_RETENTION_DAYS) ----
      const recordId = crypto.randomUUID();
      const ext = (req.file.originalname.split('.').pop() || 'bin').toLowerCase();
      const storedFileName = `${recordId}.${ext}`;
      fs.writeFileSync(path.join(FILES_DIR, storedFileName), req.file.buffer);

      // --- AI analysis: never let a failure here lose the enquiry -----------
      let analysis = null;
      let analysisError = null;
      try {
        const contentBlock = await buildContentBlock(req.file);
        analysis = await analyzeCV(contentBlock, target || '');
      } catch (e) {
        console.error('CV analysis failed:', e.message);
        analysisError = e.message;
      }

      const record = {
        id: recordId,
        submittedAt: new Date().toISOString(),
        studentName: name,
        studentEmail: email,
        phone: phone || '',
        target: target || '',
        message: message || '',
        referral: referral || '',
        fileName: req.file.originalname,
        storedFileName,
        analysis,
        analysisError
      };
      const all = readSubmissions();
      all.push(record);
      writeSubmissions(all);

      // fire and forget — don't block the student's response on email delivery
      sendEnquiryAlert(record);
      sendStudentConfirmation(record);

      res.json({ ok: true, analysis, analysisFailed: !analysis });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Something went wrong submitting your enquiry. Please try again.' });
    }
  });
});

// --- staff auth --------------------------------------------------------------
app.post('/api/staff/login', loginLimiter, (req, res) => {
  const { password } = req.body;
  if (password && password === STAFF_PASSWORD) {
    req.session.staff = true;
    res.json({ ok: true });
  } else {
    res.status(401).json({ error: 'Incorrect password' });
  }
});

app.post('/api/staff/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/staff/session', (req, res) => {
  res.json({ authenticated: !!(req.session && req.session.staff) });
});

function requireStaff(req, res, next) {
  if (req.session && req.session.staff) return next();
  res.status(401).json({ error: 'Not authenticated' });
}

app.get('/api/staff/submissions', requireStaff, (req, res) => {
  const all = readSubmissions().sort((a, b) => (b.analysis?.score || 0) - (a.analysis?.score || 0));
  res.json(all);
});

app.get('/api/staff/submissions/:id/file', requireStaff, (req, res) => {
  const all = readSubmissions();
  const record = all.find(s => s.id === req.params.id);
  if (!record || !record.storedFileName) {
    return res.status(404).json({ error: 'This CV is no longer available (files are deleted after 90 days).' });
  }
  const filePath = path.join(FILES_DIR, record.storedFileName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'This CV is no longer available.' });
  }
  res.download(filePath, record.fileName || record.storedFileName);
});

app.delete('/api/staff/submissions/:id', requireStaff, (req, res) => {
  const target = readSubmissions().find(s => s.id === req.params.id);
  if (target && target.storedFileName) {
    const filePath = path.join(FILES_DIR, target.storedFileName);
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (e) { console.error('Could not delete file:', e.message); }
    }
  }
  const all = readSubmissions().filter(s => s.id !== req.params.id);
  writeSubmissions(all);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`CV screener running on http://localhost:${PORT}`));
