import 'dotenv/config';
import crypto from 'crypto';
import express from 'express';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import { Telegraf, Markup } from 'telegraf';
import { getUser, addSession, updateCredits, clearHistory, checkAndIncrementBreakdown, setPremium, restoreStreak, FREE_DAILY_LIMIT } from './database.js';

// ─────────────────────────────────────────────
// Config & Validation
// ─────────────────────────────────────────────
const BOT_TOKEN  = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://your-app.vercel.app';
const PORT       = parseInt(process.env.PORT || '3000', 10);
const WEBHOOK_URL = process.env.WEBHOOK_URL; // undefined → polling mode
const GROQ_API_KEY = process.env.GROQ_API_KEY;

if (!GROQ_API_KEY) {
  console.warn('⚠️  GROQ_API_KEY is missing. /api/breakdown will fail.');
}

// ─────────────────────────────────────────────
// Express App
// ─────────────────────────────────────────────
const app = express();

// Restrict CORS to known origins — prevents credential harvesting from external sites
const ALLOWED_ORIGINS = [
  WEBAPP_URL,
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no Origin header (Telegram WebView, mobile, curl in dev)
    if (!origin || ALLOWED_ORIGINS.some(o => origin.startsWith(o))) return cb(null, true);
    cb(new Error('Not allowed by CORS'));
  },
  credentials: true,
}));
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
  if (!rawTask) return res.status(400).json({ error: 'Task is required' });
  if (!GROQ_API_KEY) return res.status(500).json({ error: 'Groq API not configured' });

  // ── Sanitize: strip quotes, newlines, limit to 280 chars ──
  const task = String(rawTask).replace(/['"]/g, '').replace(/\n+/g, ' ').trim().slice(0, 280);
  if (!task) return res.status(400).json({ error: 'Task text is invalid' });

  // ── Free-tier daily limit (server-side enforcement) ──
  if (userId) {
    const check = await checkAndIncrementBreakdown(String(userId)).catch(() => null);
    if (check && !check.allowed) {
      return res.status(429).json({
        error: 'DAILY_LIMIT_REACHED',
        message: `Free users get ${FREE_DAILY_LIMIT} AI breakdowns per day. Upgrade to Premium for unlimited access! ⭐`,
        upgradeRequired: true,
      });
    }
  }

  const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
  const SYSTEM_PROMPT = `You are a productivity assistant. When given a task, break it into exactly 5 clear, actionable Pomodoro-sized steps. Each step should take approximately 25 minutes. Be specific and practical. Start each step with a strong action verb. Return ONLY a valid JSON array of exactly 5 strings, no explanation, no markdown. Example: ["Step 1", "Step 2", "Step 3", "Step 4", "Step 5"]`;

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
          { role: 'user', content: `Break this task into 5 Pomodoro steps: ${task}` },
        ],
        temperature: 0.7,
        max_tokens: 512,
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

    const formattedSteps = steps.slice(0, 5).map((title, i) => ({
      id: Date.now() + i,
      title: String(title).trim(),
      completed: false,
    }));

    res.json(formattedSteps);
  } catch (err) {
    console.error('Groq breakdown error:', err.message);
    res.status(500).json({ error: err.message });
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
    res.status(err.message.includes('Premium') ? 403 : 500).json({ error: err.message });
  }
});

app.post('/api/invoice', async (req, res) => {
  if (!bot) return res.status(500).json({ error: 'Bot is offline' });
  const { userId, type = 'credits' } = req.body;
  if (!userId) return res.status(400).json({ error: 'User ID is required' });

  try {
    let invoiceOptions;

    if (type === 'premium_monthly') {
      invoiceOptions = {
        title: '⭐ Task Shredder AI Premium — Monthly',
        description: 'Unlimited AI breakdowns, custom timer, full history, streak restore & more.',
        payload: `premium_1m_${userId}_${Date.now()}`,
        provider_token: '',
        currency: 'XTR',
        prices: [{ label: 'Premium Monthly', amount: 299 }],
      };
    } else if (type === 'premium_annual') {
      invoiceOptions = {
        title: '⭐ Task Shredder AI Premium — Annual',
        description: 'Everything in Premium for 12 months. Save 44% vs monthly.',
        payload: `premium_12m_${userId}_${Date.now()}`,
        provider_token: '',
        currency: 'XTR',
        prices: [{ label: 'Premium Annual', amount: 1999 }],
      };
    } else if (type === 'premium_lifetime') {
      invoiceOptions = {
        title: '⭐ Task Shredder AI Premium — Lifetime',
        description: 'One-time purchase. All Premium features forever.',
        payload: `premium_life_${userId}_${Date.now()}`,
        provider_token: '',
        currency: 'XTR',
        prices: [{ label: 'Premium Lifetime', amount: 2499 }],
      };
    } else {
      // Default: credits pack
      invoiceOptions = {
        title: '20 AI Credits',
        description: 'Get 20 AI credits to break down tasks in Task Shredder AI.',
        payload: `credits_${userId}_${Date.now()}`,
        provider_token: '',
        currency: 'XTR',
        prices: [{ label: '20 Credits', amount: 50 }],
      };
    }

    const invoiceLink = await bot.telegram.createInvoiceLink(invoiceOptions);
    res.json({ invoiceLink });
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
    console.log('✅ Payment successful:', ctx.message.successful_payment);
    const payment = ctx.message.successful_payment;
    const payload = payment.invoice_payload;
    const parts = payload.split('_');

    try {
      if (payload.startsWith('premium_1m_')) {
        const userId = parts[2];
        await setPremium(userId, 1);
        await ctx.reply('🎉 Welcome to Premium! You now have unlimited breakdowns, custom timer, full history and more. ⭐');
      } else if (payload.startsWith('premium_12m_')) {
        const userId = parts[2];
        await setPremium(userId, 12);
        await ctx.reply('🎉 Welcome to Annual Premium! Access unlocked for 12 months. ⭐');
      } else if (payload.startsWith('premium_life_')) {
        const userId = parts[2];
        await setPremium(userId, -1); // lifetime
        await ctx.reply('🎉 Welcome to Lifetime Premium! All features unlocked forever. ⭐👑');
      } else if (payload.startsWith('credits_')) {
        const userId = parts[1];
        if (userId) await updateCredits(userId, 20);
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
    app.use(bot.webhookCallback(webhookPath));
    await bot.telegram.setWebhook(`${WEBHOOK_URL}${webhookPath}`);
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

launch().catch(err => {
  console.error('❌ Failed to launch bot:', err.message);
  process.exit(1);
});

// ── Graceful shutdown ─────────────────────────
if (bot) {
  process.once('SIGINT',  () => { bot.stop('SIGINT');  process.exit(0); });
  process.once('SIGTERM', () => { bot.stop('SIGTERM'); process.exit(0); });
}
