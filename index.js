import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { Telegraf, Markup } from 'telegraf';
import { getUser, addSession, updateCredits, clearHistory } from './database.js';

// ─────────────────────────────────────────────
// Config & Validation
// ─────────────────────────────────────────────
const BOT_TOKEN  = process.env.BOT_TOKEN;
const WEBAPP_URL = process.env.WEBAPP_URL || 'https://your-app.vercel.app';
const PORT       = parseInt(process.env.PORT || '3000', 10);
const WEBHOOK_URL = process.env.WEBHOOK_URL; // undefined → polling mode
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.warn('⚠️ GEMINI_API_KEY is missing. /api/breakdown will fail.');
}

// ─────────────────────────────────────────────
// Express App
// ─────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'FocusFlow Bot', ts: new Date().toISOString() });
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
        `👋 Hey ${name}! Welcome to *FocusFlow AI* ⚡\n\n` +
        `I help you break any task into 5 focused Pomodoro sessions using the power of Gemini AI.\n\n` +
        `✅ AI-powered task breakdown\n` +
        `⏱️ 25-min Pomodoro timer with break modes\n` +
        `🔥 Daily streak tracking\n` +
        `⚡ Credits system (watch ads or buy with Stars)\n\n` +
        `Tap the button below to launch the app 👇`,
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.webApp('🚀 Open FocusFlow AI', WEBAPP_URL)],
        [Markup.button.callback('ℹ️ How it works', 'how_it_works')],
      ]),
    }
  ).catch(() => {
    // Fallback if photo upload fails (e.g. URL unreachable)
    return ctx.reply(
      `👋 Hey ${name}! Welcome to *FocusFlow AI* ⚡\n\n` +
      `Break any task into 5 focused Pomodoro sessions with Gemini AI.`,
      {
        parse_mode: 'Markdown',
        ...Markup.inlineKeyboard([
          [Markup.button.webApp('🚀 Open FocusFlow AI', WEBAPP_URL)],
        ]),
      }
    );
  });
});

// ── /help ────────────────────────────────────
bot.help(async (ctx) => {
  await ctx.reply(
    `*FocusFlow AI – Help* 🧠\n\n` +
    `*Commands:*\n` +
    `/start – Launch the app\n` +
    `/help – Show this message\n` +
    `/about – About FocusFlow AI\n\n` +
    `*How it works:*\n` +
    `1️⃣ Type your goal in the app\n` +
    `2️⃣ Gemini AI breaks it into 5 steps\n` +
    `3️⃣ Start a Pomodoro timer for each step\n` +
    `4️⃣ Take breaks, build streaks, get things done! 🔥\n\n` +
    `*Credits:*\n` +
    `Each AI breakdown costs 1 credit. Watch ads to earn more, or buy with Telegram Stars ⭐`,
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
    `*FocusFlow AI* is a Telegram Mini App productivity tool.\n\n` +
    `Built with:\n` +
    `• React + Vite (frontend)\n` +
    `• Google Gemini 2.0 Flash (AI)\n` +
    `• Pomodoro Technique (focus method)\n` +
    `• Adsgram (rewarded ads)\n` +
    `• Telegram Stars (payments)\n\n` +
    `Version: 1.0.0`,
    { parse_mode: 'Markdown' }
  );
});

// ── Inline button: "How it works" ─────────────
bot.action('how_it_works', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    `*How FocusFlow AI works:* 🧠\n\n` +
    `The *Pomodoro Technique* breaks work into 25-minute focused sessions separated by short breaks.\n\n` +
    `FocusFlow AI supercharges this by:\n` +
    `🤖 Using Gemini AI to plan *exactly* what to do in each session\n` +
    `⏱️ Running an in-app timer with auto break detection\n` +
    `🔥 Tracking your daily streak to keep you motivated`,
    { parse_mode: 'Markdown' }
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

app.post('/api/breakdown', async (req, res) => {
  const { task } = req.body;
  if (!task) return res.status(400).json({ error: 'Task is required' });
  if (!GEMINI_API_KEY) return res.status(500).json({ error: 'Gemini API not configured' });

  const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
  
  const PROMPT_TEMPLATE = `
Break the following task into exactly 5 clear, actionable Pomodoro-sized steps.
Each step should take approximately 25 minutes to complete.
Be specific and practical. Start each step with a strong action verb.

Task: "${task}"

Return ONLY a valid JSON array of 5 strings, no explanation, no markdown, no code fences.
Example format: ["Step 1 description", "Step 2 description", "Step 3 description", "Step 4 description", "Step 5 description"]
`.trim();

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: PROMPT_TEMPLATE }] }],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 512,
          responseMimeType: 'application/json',
        },
      }),
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err?.error?.message || `HTTP ${response.status}`);
    }

    const data = await response.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) throw new Error('Empty response from Gemini');

    let steps;
    try {
      steps = JSON.parse(raw);
    } catch {
      const match = raw.match(/\[[\s\S]*\]/);
      if (match) steps = JSON.parse(match[0]);
      else throw new Error('Could not parse AI response');
    }

    if (!Array.isArray(steps) || steps.length === 0) {
      throw new Error('Invalid response format from Gemini');
    }

    // Assign IDs locally in the backend for convenience
    const formattedSteps = steps.slice(0, 5).map((title, i) => ({
      id: Date.now() + i,
      title: String(title).trim(),
      completed: false,
    }));

    res.json(formattedSteps);
  } catch (err) {
    console.error('Gemini breakdown error:', err.message);
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

app.post('/api/user/:userId/session', async (req, res) => {
  try {
    const user = await addSession(req.params.userId, req.body.taskTitle || "Completed Task");
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/user/:userId/credits', async (req, res) => {
  try {
    const newCredits = await updateCredits(req.params.userId, req.body.amount);
    res.json({ credits: newCredits });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/user/:userId/history', async (req, res) => {
  try {
    await clearHistory(req.params.userId);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/invoice', async (req, res) => {
  if (!bot) return res.status(500).json({ error: 'Bot is offline' });
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'User ID is required' });
  try {
    const payload = `credits_${userId}_${Date.now()}`;
    const invoiceLink = await bot.telegram.createInvoiceLink({
      title: '20 AI Credits',
      description: 'Get 20 AI credits to break down tasks in FocusFlow',
      payload: payload,
      provider_token: '',  // Empty for Telegram Stars
      currency: 'XTR',
      prices: [{ label: '20 Credits', amount: 50 }] // 50 Telegram Stars
    });
    res.json({ invoiceLink });
  } catch (err) {
    console.error('Invoice generation failed:', err);
    res.status(500).json({ error: 'Failed to generate invoice link' });
  }
});

// ── Telegram Payment Webhooks ─────────────────
if (bot) {
  bot.on('pre_checkout_query', async (ctx) => {
    // Accept all checkouts for digital goods
    await ctx.answerPreCheckoutQuery(true).catch(console.error);
  });

  bot.on('successful_payment', async (ctx) => {
    console.log('✅ Payment successful:', ctx.message.successful_payment);
    const payload = ctx.message.successful_payment.invoice_payload;
    if (payload.startsWith('credits_')) {
       const userId = payload.split('_')[1];
       if (userId) {
         try {
           await updateCredits(userId, 20);
         } catch (err) {
           console.error("Failed adding credits to DB", err);
         }
       }
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
