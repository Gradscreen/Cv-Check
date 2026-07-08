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

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'submissions.json');
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'changeme';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const MAX_FILE_BYTES = 4 * 1024 * 1024; // 4MB

if (!process.env.ANTHROPIC_API_KEY) {
  console.warn('WARNING: ANTHROPIC_API_KEY is not set. CV analysis will fail until you add it to .env');
}
if (STAFF_PASSWORD === 'changeme') {
  console.warn('WARNING: STAFF_PASSWORD is using the default value. Set a real password in .env before going live.');
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// --- tiny JSON file "database" -------------------------------------------
// Fine for small/medium volume. Swap for a real database later if you need
// concurrent writes at scale or multi-server deployment.
fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]');

function readSubmissions() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
}
function writeSubmissions(list) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2));
}

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

// Basic abuse protection — tune to your expected traffic.
const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many submissions from this device. Please try again in an hour.' }
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' }
});

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

// --- student-facing endpoint ------------------------------------------------
app.post('/api/submit', submitLimiter, (req, res) => {
  upload.single('cv')(req, res, async (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? 'File is too large — please use a file under 4MB.'
        : (err.message || 'Upload failed');
      return res.status(400).json({ error: msg });
    }
    try {
      const { name, email, target, consent } = req.body;
      if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });
      if (consent !== 'true') return res.status(400).json({ error: 'Please confirm consent to processing before submitting' });
      if (!req.file) return res.status(400).json({ error: 'No CV file uploaded' });

      const contentBlock = await buildContentBlock(req.file);
      const analysis = await analyzeCV(contentBlock, target || '');

      const record = {
        id: crypto.randomUUID(),
        submittedAt: new Date().toISOString(),
        studentName: name,
        studentEmail: email,
        target: target || '',
        fileName: req.file.originalname,
        analysis
      };
      const all = readSubmissions();
      all.push(record);
      writeSubmissions(all);

      res.json({ ok: true, analysis });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: 'Something went wrong analyzing this CV. Please try again.' });
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

app.delete('/api/staff/submissions/:id', requireStaff, (req, res) => {
  const all = readSubmissions().filter(s => s.id !== req.params.id);
  writeSubmissions(all);
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`CV screener running on http://localhost:${PORT}`));
