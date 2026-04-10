import 'dotenv/config';
import crypto from 'crypto';
import express from 'express';
import cors from 'cors';
import compression from 'compression';
import { rateLimit } from 'express-rate-limit';
import { Telegraf, Markup } from 'telegraf';
import { getUser, addSession, updateCredits, clearHistory, checkAndIncrementBreakdown, setUserPlan, restoreStreak, recordPayment, FREE_DAILY_LIMIT } from './database.js';

// ─────────────────────────────────────────────
// Config & Validation
// ─────────────────────────────────────────────
const BOT_TOKEN  = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://your-app.vercel.app';
const PORT       = parseInt(process.env.PORT || '3000', 10);
const WEBHOOK_URL = process.env.WEBHOOK_URL; // undefined → polling mode
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET
  || crypto.createHash('sha256').update(String(BOT_TOKEN || 'bot')).digest('hex').slice(0, 32);
const PAYMENT_PAYLOAD_SECRET = process.env.PAYMENT_PAYLOAD_SECRET
  || crypto.createHash('sha256').update(String(BOT_TOKEN || 'pay')).digest('hex');

if (!GROQ_API_KEY) {
  console.warn('⚠️  GROQ_API_KEY is missing. /api/breakdown will fail.');
}

// ─────────────────────────────────────────────
// Express App
// ─────────────────────────────────────────────
const app = express();

// CORS: allow Telegram WebView (no origin), any *.vercel.app deploy, and localhost dev servers.
// No env config needed.
function isAllowedOrigin(origin) {
  if (!origin) return true; // Telegram WebView / curl / mobile
  if (origin.endsWith('.vercel.app')) return true;
  if (/^https?:\/\/localhost(:\d+)?$/.test(origin)) return true;
  if (/^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) return true;
  return false;
}

app.use(cors({
  origin: (origin, cb) => {
    if (isAllowedOrigin(origin)) return cb(null, true);
    console.warn(`[CORS] Blocked origin: ${origin}`);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
app.use(compression()); // gzip all JSON responses
app.use(express.json({ limit: '16kb' }));

// ── Telegram initData verification (HMAC-SHA256) ────────
// Applied to write endpoints to prevent credit manipulation
function verifyTelegramInitData(initData) {
  if (!BOT_TOKEN || !initData) return false;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return false;
    params.delete('hash');
    const dataCheckStr = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
    const computed = crypto.createHmac('sha256', secret).update(dataCheckStr).digest('hex');
    return computed === hash;
  } catch { return false; }
}

// Middleware — verifies initData on write endpoints; skips in dev (no initData)
function withTelegramAuth(req, res, next) {
  const initData = req.headers['x-telegram-init-data'] || '';
  const isDev = !initData; // dev mode: no initData present
  if (!isDev && !verifyTelegramInitData(initData)) {
    return res.status(401).json({ error: 'Unauthorized: invalid Telegram session' });
  }
  next();
}

function extractTelegramUserId(initData) {
  try {
    if (!initData) return null;
    const params = new URLSearchParams(initData);
    const userRaw = params.get('user');
    if (!userRaw) return null;
    const parsed = JSON.parse(userRaw);
    return parsed?.id ? String(parsed.id) : null;
  } catch {
    return null;
  }
}

function createSignedPayload({ product, userId, plan }) {
  const ts = Date.now().toString(36);
  const nonce = crypto.randomBytes(4).toString('hex');
  const raw = `v1|${product}|${userId}|${plan}|${ts}|${nonce}`;
  const sig = crypto.createHmac('sha256', PAYMENT_PAYLOAD_SECRET).update(raw).digest('hex').slice(0, 12);
  return `${raw}|${sig}`;
}

function parseAndVerifyPayload(payload) {
  const parts = String(payload || '').split('|');
  if (parts.length !== 7 || parts[0] !== 'v1') return null;

  const [version, product, userId, plan, ts, nonce, sig] = parts;
  const raw = `${version}|${product}|${userId}|${plan}|${ts}|${nonce}`;
  const expected = crypto.createHmac('sha256', PAYMENT_PAYLOAD_SECRET).update(raw).digest('hex').slice(0, 12);
  if (sig !== expected) return null;

  return { product, userId, plan, ts, nonce };
}

// Rate Limiting: 100 requests per 15 mins for general, 5 per min for AI
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' }
});

const aiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 5,
  message: { error: 'AI is over capacity. Please wait 60s before shredding another task.' }
});

app.use('/api/', generalLimiter);

// Health check
app.get('/', (req, res) => {
  res.send('Task Shredder API is running!');
});

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'Task Shredder API', ts: new Date().toISOString() });
});

// ─────────────────────────────────────────────
// Telegraf Bot
// ─────────────────────────────────────────────
let bot = null;
if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);

  // ── /start ──────────────
  bot.start(async (ctx) => {
  const name = ctx.from?.first_name || 'there';
  await ctx.replyWithPhoto(
    { url: 'https://i.ibb.co/0GzqfB6/focusflow-banner.png' },
    {
      caption:
        `👋 Hey ${name}! Welcome to *Task Shredder AI* ⚡\n\n` +
        `Break any overwhelming goal into 5 focused Pomodoro steps — powered by Groq AI.\n\n` +
        `✅ AI task breakdown (Groq / Llama 3.3)\n` +
        `⏱️ 25-min Pomodoro timer with break modes\n` +
        `🔥 Daily streak tracking\n` +
        `⚡ Credits system (watch ads or buy with Stars)\n` +
        `⭐ *Premium*: unlimited shreds, custom timer, full history\n\n` +
        `Tap below to launch 👇`,
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.webApp('🚀 Open Task Shredder AI', WEBAPP_URL)],
        [Markup.button.callback('ℹ️ How it works', 'how_it_works')],
        [Markup.button.callback('⭐ Get Premium', 'show_premium')],
      ]),
    }
  ).catch(() => {
    return ctx.reply(
      `👋 Hey ${name}! Welcome to *Task Shredder AI* ⚡\n\n` +
      `Break any task into 5 focused Pomodoro sessions with Groq AI.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.webApp('🚀 Open Task Shredder AI', WEBAPP_URL)],
        ]),
      }
    );
  });
});

// ── /help ────────────────────────────────────
bot.help(async (ctx) => {
  await ctx.reply(
    `*Task Shredder AI – Help* 🧠\n\n` +
    `*Commands:*\n` +
    `/start – Launch the app\n` +
    `/help – Show this message\n` +
    `/about – About Task Shredder AI\n\n` +
    `*How it works:*\n` +
    `1️⃣ Type your goal in the app\n` +
    `2️⃣ Groq AI breaks it into 5 Pomodoro steps\n` +
    `3️⃣ Start a 25-min Pomodoro timer for each step\n` +
    `4️⃣ Take breaks, build streaks, get things done! 🔥\n\n` +
    `*Free tier:* ${FREE_DAILY_LIMIT} AI breakdowns/day\n` +
    `*⭐ Premium:* Unlimited, custom timer, full history, streak restore`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.webApp('🚀 Open App', WEBAPP_URL)],
      ]),
    }
  );
});

// ── /about ───────────────────────────────────
bot.command('about', async (ctx) => {
  await ctx.reply(
    `*Task Shredder AI* is a Telegram Mini App productivity tool.\n\n` +
    `Built with:\n` +
    `• React + Vite (frontend)\n` +
    `• Groq Cloud / Llama 3.3 70B (AI)\n` +
    `• Pomodoro Technique (focus method)\n` +
    `• Adsgram (rewarded ads)\n` +
    `• Telegram Stars (payments)\n\n` +
    `Version: 2.0.0`,
    { parse_mode: 'Markdown' }
  );
});

// ── Inline button: "How it works" ─────────────
bot.action('how_it_works', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    `*How Task Shredder AI works:* 🧠\n\n` +
    `The *Pomodoro Technique* breaks work into 25-minute focused sessions separated by short breaks.\n\n` +
    `Task Shredder AI supercharges this by:\n` +
    `🤖 Using *Groq AI (Llama 3.3)* to plan exactly what to do in each session\n` +
    `⏱️ Running an in-app timer with auto break detection\n` +
    `🔥 Tracking your daily streak to keep you motivated\n\n` +
    `*⭐ Premium* unlocks unlimited daily breakdowns, custom timer durations, full session history, and streak restore.`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('show_premium', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    `*⭐ Task Shredder AI Premium*\n\n` +
    `Unlock the full productivity experience:\n` +
    `• ∞ Unlimited AI breakdowns per day\n` +
    `• 📅 Full session history\n` +
    `• 📊 7-day productivity chart\n` +
    `• ⏱️ Custom Pomodoro durations (15/25/50 min)\n` +
    `• 🔥 Streak restore\n` +
    `• 🟣 Premium badge\n` +
    `• No forced ads\n\n` +
    `*Plans:*\n` +
    `Monthly — 299 ⭐ Stars\n` +
    `Annual — 1999 ⭐ Stars (save 44%)\n` +
    `Lifetime — 2499 ⭐ Stars`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.webApp('🚀 Open App to Upgrade', WEBAPP_URL)],
      ]),
    }
  );
});

} // <-- closes if (BOT_TOKEN)

// ── Global error handler ──────────────────────
if (bot) {
  bot.catch((err, ctx) => {
    console.error(`⚠️ Bot error for update ${ctx.updateType}:`, err.message);
  });
}

// ─────────────────────────────────────────────
// API Endpoints for Frontend
// ─────────────────────────────────────────────

app.post('/api/break-task', aiLimiter, async (req, res) => {
  const rawTask = req.body?.task;
  const userId  = req.body?.userId;
  const mode = String(req.body?.mode || 'focus').toLowerCase();
  if (!rawTask) return res.status(400).json({ error: 'Task is required' });
  if (!GROQ_API_KEY) return res.status(500).json({ error: 'Groq API not configured' });

  // ── Sanitize: strip quotes, newlines, limit to 280 chars ──
  const task = String(rawTask).replace(/['"]/g, '').replace(/\n+/g, ' ').trim().slice(0, 280);
  if (!task) return res.status(400).json({ error: 'Task text is invalid' });

  // ── Free-tier daily limit (server-side enforcement) ──
  let userPlan = 'free';
  if (userId) {
    const check = await checkAndIncrementBreakdown(String(userId)).catch(() => null);
    userPlan = check?.plan || (await getUser(String(userId)).then(u => u?.plan).catch(() => 'free'));
    if (check && !check.allowed) {
      return res.status(429).json({
        error: 'DAILY_LIMIT_REACHED',
        message: `Free users get ${FREE_DAILY_LIMIT} AI breakdowns per day. You're becoming productive 🔥 Unlock unlimited mode?`,
        upgradeRequired: true,
      });
    }
  }

  const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
  const isPro = userPlan === 'pro';
  const isStarter = userPlan === 'starter';

  const SYSTEM_PROMPT = isPro
    ? `You are an elite productivity coach. Build exactly 5 micro-actionable steps for the task.
Use mode="${mode}" where focus=high-discipline, deep=long concentration blocks, lazy=low-friction momentum.
For EACH step provide: title, time, difficulty, motivation.
Return JSON only: {"steps":[{"title":"...","time":"...","difficulty":"Easy 🟢|Medium 🟡|Hard 🔴","motivation":"..."}]}`
    : isStarter
      ? `Break the task into exactly 5 practical action steps for fast execution.
Keep output concise and clear. Return JSON only: {"steps":[{"title":"...","time":"...","difficulty":"Easy 🟢|Medium 🟡|Hard 🔴","motivation":"..."}]}`
      : `Break the task into exactly 5 basic actionable steps for a beginner.
Keep each step short, clear, and simple. Return JSON only: {"steps":["Step 1","Step 2","Step 3","Step 4","Step 5"]}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(GROQ_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Break this task into 5 prioritised micro-steps: ${task}` },
        ],
        temperature: isPro ? 0.7 : 0.45,
        max_tokens: isPro ? 520 : isStarter ? 360 : 220,
        response_format: { type: 'json_object' },
      }),
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err?.error?.message || `HTTP ${response.status}`);
    }

    const data = await response.json();
    const raw = data?.choices?.[0]?.message?.content;
    if (!raw) throw new Error('Empty response from Groq');

    let steps;
    try {
      const parsed = JSON.parse(raw);
      steps = Array.isArray(parsed) ? parsed : (parsed.steps || parsed.tasks || Object.values(parsed)[0]);
    } catch {
      const match = raw.match(/\[[\s\S]*\]/);
      if (match) steps = JSON.parse(match[0]);
      else throw new Error('Could not parse Groq response');
    }

    if (!Array.isArray(steps) || steps.length === 0) {
      throw new Error('Invalid response format from Groq');
    }

    const formattedSteps = steps.slice(0, 5).map((step, i) => ({
      id: Date.now() + i,
      title: String(typeof step === 'string' ? step : (step.title || step)).trim(),
      time: isPro || isStarter ? (step.time || '25 min') : '',
      difficulty: isPro || isStarter ? (step.difficulty || 'Medium 🟡') : '',
      motivation: isPro ? (step.motivation || '') : '',
      completed: false,
    }));

    res.json(formattedSteps);
  } catch (err) {
    console.error('Groq breakdown error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Streaming task breakdown (SSE) ────────────
// Each step is emitted as `data: {JSON}\n\n` the moment it is parsed.
// The client renders steps live — no waiting for the full response.
app.post('/api/break-task-stream', aiLimiter, async (req, res) => {
  const rawTask = req.body?.task;
  const userId  = req.body?.userId;
  const mode = String(req.body?.mode || 'focus').toLowerCase();
  if (!rawTask) return res.status(400).json({ error: 'Task is required' });
  if (!GROQ_API_KEY) return res.status(500).json({ error: 'Groq API not configured' });

  const task = String(rawTask).replace(/['"]/g, '').replace(/\n+/g, ' ').trim().slice(0, 280);
  if (!task) return res.status(400).json({ error: 'Task text is invalid' });

  let userPlan = 'free';
  if (userId) {
    const check = await checkAndIncrementBreakdown(String(userId)).catch(() => null);
    userPlan = check?.plan || (await getUser(String(userId)).then(u => u?.plan).catch(() => 'free'));
    if (check && !check.allowed) {
      return res.status(429).json({
        error: 'DAILY_LIMIT_REACHED',
        message: `Free users get ${FREE_DAILY_LIMIT} AI breakdowns per day. You're becoming productive 🔥 Unlock unlimited mode?`,
        upgradeRequired: true,
      });
    }
  }

  // SSE headers — compression is skipped for SSE (streaming body)
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable Nginx buffering on Vercel
  res.flushHeaders();

  const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
  const isPro = userPlan === 'pro';
  const isStarter = userPlan === 'starter';
  // Each step is requested as its own JSON object on a separate line for easy stream parsing.
  const STREAM_PROMPT = isPro
    ? `You are a world-class productivity coach. Break the task into exactly 5 prioritised micro-steps using mode=${mode}.
Output ONLY 5 lines. Each line must be a self-contained JSON object — no array wrapper, no markdown, no extra text:
{"title":"<1 emoji + strong action verb + hyper-specific action>","time":"<e.g. 15 min>","difficulty":"<Easy 🟢 OR Medium 🟡 OR Hard 🔴>","motivation":"<max 10 words, punchy and personal>"}
Newline between each JSON object. No other text.`
    : isStarter
      ? `Break the task into exactly 5 practical fast-execution steps.
Output ONLY 5 lines. Each line must be a JSON object:
{"title":"...","time":"...","difficulty":"Easy 🟢 OR Medium 🟡 OR Hard 🔴","motivation":""}`
      : `Break the task into exactly 5 basic beginner-friendly steps.
Output ONLY 5 lines. Each line must be a JSON object:
{"title":"..."}`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    const groqRes = await fetch(GROQ_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: STREAM_PROMPT },
          { role: 'user', content: `Task: ${task}` },
        ],
        temperature: isPro ? 0.7 : 0.45,
        max_tokens: isPro ? 620 : isStarter ? 380 : 220,
        stream: true,
      }),
    });

    clearTimeout(timeout);

    if (!groqRes.ok) {
      const errBody = await groqRes.json().catch(() => ({}));
      res.write(`data: ${JSON.stringify({ error: errBody?.error?.message || `HTTP ${groqRes.status}` })}\n\n`);
      return res.end();
    }

    const reader = groqRes.body.getReader();
    const dec = new TextDecoder();
    let buf = '';    // accumulates raw Groq SSE chunks
    let lineBuf = ''; // accumulates model output tokens
    let stepCount = 0;

    const tryEmitLine = (line) => {
      const t = line.trim();
      if (!t.startsWith('{')) return;
      try {
        const step = JSON.parse(t);
        if (!step.title) return;
        stepCount++;
        res.write(`data: ${JSON.stringify({
          id: Date.now() + stepCount,
          title: String(step.title).trim(),
          time: isPro || isStarter ? (step.time || '25 min') : '',
          difficulty: isPro || isStarter ? (step.difficulty || 'Medium 🟡') : '',
          motivation: isPro ? (step.motivation || '') : '',
          completed: false,
        })}\n\n`);
      } catch { /* incomplete JSON, ignore */ }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });

      // Each Groq SSE line is `data: {...}\n`; split and process
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';

      for (const rawLine of lines) {
        if (!rawLine.startsWith('data: ')) continue;
        const payload = rawLine.slice(6).trim();
        if (payload === '[DONE]') continue;
        try {
          const chunk = JSON.parse(payload);
          const token = chunk.choices?.[0]?.delta?.content ?? '';
          lineBuf += token;

          // Emit each newline-terminated JSON line as soon as it's complete
          const nlIdx = lineBuf.lastIndexOf('\n');
          if (nlIdx !== -1) {
            const done = lineBuf.slice(0, nlIdx);
            lineBuf = lineBuf.slice(nlIdx + 1);
            for (const ln of done.split('\n')) tryEmitLine(ln);
          }
        } catch { /* non-JSON chunk */ }
      }
    }

    // Flush remaining buffer
    for (const ln of lineBuf.split('\n')) tryEmitLine(ln);

    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    console.error('[Stream] Error:', err.message);
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.end();
    }
  }
});

// ── State Endpoints ───────────────────────────
app.get('/api/user/:userId', async (req, res) => {
  try {
    const user = await getUser(req.params.userId);
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/user/:userId/session', withTelegramAuth, async (req, res) => {
  try {
    const user = await addSession(req.params.userId, req.body.taskTitle || 'Completed Task');
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/user/:userId/credits', withTelegramAuth, async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    if (!Number.isInteger(amount) || amount < -100 || amount > 100) {
      return res.status(400).json({ error: 'Invalid credit amount' });
    }
    const newCredits = await updateCredits(req.params.userId, amount);
    res.json({ credits: newCredits });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/user/:userId/history', withTelegramAuth, async (req, res) => {
  try {
    await clearHistory(req.params.userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Premium endpoints ─────────────────────────
app.post('/api/user/:userId/streak-restore', withTelegramAuth, async (req, res) => {
  try {
    const user = await restoreStreak(req.params.userId);
    res.json(user);
  } catch (err) {
    res.status(err.message.includes('Pro') ? 403 : 500).json({ error: err.message });
  }
});

app.post('/api/invoice', withTelegramAuth, async (req, res) => {
  if (!bot) return res.status(500).json({ error: 'Bot is offline' });
  const { userId, type = 'starter_plan' } = req.body;
  if (!userId) return res.status(400).json({ error: 'User ID is required' });

  const telegramUserId = extractTelegramUserId(req.headers['x-telegram-init-data'] || '');
  if (telegramUserId && telegramUserId !== String(userId)) {
    return res.status(403).json({ error: 'User mismatch for invoice creation' });
  }

  try {
    let invoiceOptions;

    if (type === 'starter_plan') {
      invoiceOptions = {
        title: 'Starter Access',
        description: 'Unlimited task generation, history, copy/share, fast mode',
        payload: createSignedPayload({ product: 'plan_upgrade', userId, plan: 'starter' }),
        provider_token: '',
        currency: 'XTR',
        prices: [{ label: 'Starter Plan', amount: 100 }],
      };
    } else if (type === 'pro_plan') {
      invoiceOptions = {
        title: 'Pro Access',
        description: 'Advanced AI breakdown, smart modes, deep productivity tools',
        payload: createSignedPayload({ product: 'plan_upgrade', userId, plan: 'pro' }),
        provider_token: '',
        currency: 'XTR',
        prices: [{ label: 'Pro Plan', amount: 300 }],
      };
    } else if (type === 'basic_boost') {
      invoiceOptions = {
        title: 'Basic Boost',
        description: 'Small Stars support pack with +10 credits',
        payload: createSignedPayload({ product: 'credits_pack', userId, plan: 'basic_credits' }),
        provider_token: '',
        currency: 'XTR',
        prices: [{ label: 'Basic Boost', amount: 50 }],
      };
    } else {
      invoiceOptions = {
        title: 'Starter Access',
        description: 'Unlimited task generation, history, copy/share, fast mode',
        payload: createSignedPayload({ product: 'plan_upgrade', userId, plan: 'starter' }),
        provider_token: '',
        currency: 'XTR',
        prices: [{ label: 'Starter Plan', amount: 100 }],
      };
    }

    const invoiceLink = await bot.telegram.createInvoiceLink(invoiceOptions);
    res.json({ invoiceLink, type, currency: 'XTR' });
  } catch (err) {
    console.error('Invoice generation failed:', err);
    res.status(500).json({ error: 'Failed to generate invoice link' });
  }
});

// ── Telegram Payment Webhooks ─────────────────
if (bot) {
  bot.on('pre_checkout_query', async (ctx) => {
    await ctx.answerPreCheckoutQuery(true).catch(console.error);
  });

  bot.on('successful_payment', async (ctx) => {
    const payment = ctx.message.successful_payment;
    const parsed = parseAndVerifyPayload(payment?.invoice_payload);
    if (!parsed) {
      console.error('❌ Invalid payment payload signature:', payment?.invoice_payload);
      return;
    }

    const { product, userId, plan } = parsed;
    const chargeId = payment.telegram_payment_charge_id;

    try {
      const recorded = await recordPayment({
        telegram_payment_charge_id: chargeId,
        provider_payment_charge_id: payment.provider_payment_charge_id || null,
        user_id: userId,
        payload: payment.invoice_payload,
        product,
        plan,
        amount: payment.total_amount,
        currency: payment.currency,
      });

      if (!recorded.inserted) {
        console.log(`ℹ️ Duplicate payment ignored: ${chargeId}`);
        return;
      }

      if (product === 'plan_upgrade') {
        if (plan === 'pro') {
          await setUserPlan(userId, 'pro');
          await ctx.reply('🎉 Pro unlocked! Advanced AI modes are now active. ⭐');
        } else {
          await setUserPlan(userId, 'starter');
          await ctx.reply('🎉 Starter unlocked! Unlimited task generation is now active. ⭐');
        }
      } else if (product === 'credits_pack') {
        await updateCredits(userId, 10);
        await ctx.reply('✅ Payment received. +10 AI credits have been added. ⚡');
      }
    } catch (err) {
      console.error('Failed processing payment:', err);
    }
  });
}

// ─────────────────────────────────────────────
// Launch Strategy
// ─────────────────────────────────────────────
async function launch() {
  if (!bot) {
    console.warn('⚠️ Running without Telegram Bot. API server only.');
    app.listen(PORT, () => {
      console.log(`🚀 FocusFlow API server running on port ${PORT}`);
    });
    return;
  }

  if (WEBHOOK_URL) {
    // ── Production: webhook mode ──────────────
    const webhookPath = `/webhook/${BOT_TOKEN.slice(-10)}`;
    app.post(webhookPath, (req, res, next) => {
      const incoming = req.headers['x-telegram-bot-api-secret-token'];
      if (incoming !== TELEGRAM_WEBHOOK_SECRET) {
        return res.status(401).json({ error: 'Invalid Telegram webhook secret' });
      }
      return bot.webhookCallback(webhookPath)(req, res, next);
    });

    await bot.telegram.setWebhook(`${WEBHOOK_URL}${webhookPath}`, {
      secret_token: TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ['message', 'callback_query', 'pre_checkout_query'],
    });
    console.log(`🔗 Webhook set to ${WEBHOOK_URL}${webhookPath}`);

    app.listen(PORT, () => {
      console.log(`🚀 FocusFlow Bot server running on port ${PORT}`);
    });
  } else {
    // ── Development: long polling ─────────────
    await bot.telegram.deleteWebhook();
    bot.launch();
    console.log('🤖 FocusFlow Bot started in polling mode');
    console.log(`🌐 Webapp URL: ${WEBAPP_URL}`);

    app.listen(PORT, () => {
      console.log(`🚀 Health server running on http://localhost:${PORT}/health`);
    });
  }
}

// ── Express error middleware ────────────────────────────
// Must be registered AFTER all routes.
// Ensures CORS headers are always present on error responses so the
// browser never sees a naked CORS block caused by a server crash.
app.use((err, req, res, _next) => {
  const origin = req.headers.origin || '';
  if (isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
  }
  const status = err.status || err.statusCode || 500;
  console.error(`[Error] ${req.method} ${req.path} →`, err.message);
  res.status(status).json({ error: err.message || 'Internal server error' });
});

launch().catch(err => {
  console.error('❌ Failed to launch bot:', err.message);
  process.exit(1);
});

// ── Graceful shutdown ─────────────────────────
if (bot) {
  process.once('SIGINT',  () => { bot.stop('SIGINT');  process.exit(0); });
  process.once('SIGTERM', () => { bot.stop('SIGTERM'); process.exit(0); });
}
