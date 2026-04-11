import { createClient } from '@supabase/supabase-js';

// Supabase is optional — if env vars are missing the app runs with in-memory defaults
const SUPABASE_READY = !!(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);
const supabase = SUPABASE_READY
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  : null;

if (!SUPABASE_READY) {
  console.warn('⚠️  SUPABASE_URL / SUPABASE_ANON_KEY not set. Running with in-memory user defaults.');
}

// ── Free tier constants ───────────────────────────────────
export const FREE_DAILY_LIMIT = 5;
export const FREE_MAX_CREDITS = 30;
export const PREMIUM_MAX_CREDITS = 500;

// ── Helpers ───────────────────────────────────────────────
function getTodayStr() {
  return new Date().toISOString().split('T')[0];
}

function getDayDiffFromToday(dateStr) {
  if (!dateStr) return Infinity;
  const today = new Date(getTodayStr());
  const last = new Date(dateStr);
  return Math.round((today - last) / (1000 * 60 * 60 * 24));
}

function isPremiumActive(user) {
  if (!user.is_premium) return false;
  if (!user.premium_expiry) return true;
  return new Date(user.premium_expiry) > new Date();
}

function normalizePlan(user) {
  const active = isPremiumActive(user);
  if (!active) return 'free';

  const raw = String(user.plan || '').toLowerCase();
  if (raw === 'starter' || raw === 'pro' || raw === 'free') return raw;

  // Backward compatibility with legacy premium plan names
  if (raw.includes('lifetime') || raw.includes('annual') || raw.includes('pro')) return 'pro';
  return 'starter';
}

// ── Coin system constants ─────────────────────────────────
export const DAILY_COIN_LIMIT = 50;    // max coins earned from ads per day
export const AD_COOLDOWN_SECONDS = 30; // min gap between SEPARATE ad rewards
export const SAME_AD_WINDOW_SECONDS = 10; // within this window treat as same ad (idempotent)
export const COINS_PER_AD = 10;        // coins awarded per completed ad

// Default user shape returned when DB is unavailable
function defaultUserResponse(id) {
  return {
    id,
    telegramId: id,
    credits: 10,
    streak: 0,
    lastStreak: 0,
    todaySessions: 0,
    lastActiveDay: null,
    totalCompleted: 0,
    isPremium: false,
    isPro: false,
    premiumExpiry: null,
    plan: 'free',
    dailyBreakdowns: 0,
    taskCountToday: 0,
    dailyBreakdownDate: getTodayStr(),
    history: [],
    dailyBreakdownsLeft: FREE_DAILY_LIMIT,
    freeLimit: FREE_DAILY_LIMIT,
    coins: 0,
    dailyCoinsEarned: 0,
    dailyCoinLimit: DAILY_COIN_LIMIT,
  };
}

async function getOrCreateUser(id) {
  if (!supabase) return null; // caller must handle null

  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', id)
    .single();

  if (error && error.code === 'PGRST116') {
    const { data: newUser, error: insertErr } = await supabase
      .from('users')
      .insert({ id, telegram_id: id, plan: 'free' })
      .select()
      .single();
    if (insertErr) throw insertErr;
    return newUser;
  }
  if (error) throw error;
  return user;
}

// ── Public API ────────────────────────────────────────────
export async function getUser(id) {
  if (!supabase) return defaultUserResponse(id);

  try {
    let user = await getOrCreateUser(id);
    const today = getTodayStr();
    const updates = {};

    if (user.is_premium && user.premium_expiry && new Date(user.premium_expiry) < new Date()) {
      updates.is_premium = false;
      updates.premium_expiry = null;
    }

    const diff = getDayDiffFromToday(user.last_active_day);

    if (diff > 1 && user.streak > 0) {
      updates.last_streak = user.streak;
      updates.streak = 0;
    }
    if (diff !== 0 && user.today_sessions > 0) {
      updates.today_sessions = 0;
    }
    if (user.daily_breakdown_date !== today) {
      updates.daily_breakdowns = 0;
      updates.task_count_today = 0;
      updates.daily_breakdown_date = today;
    }

    if (Object.keys(updates).length > 0) {
      const { data: updated, error } = await supabase
        .from('users')
        .update(updates)
        .eq('id', id)
        .select()
        .single();
      if (!error) user = updated;
    }

    const { data: history } = await supabase
      .from('sessions')
      .select('title, completed_at')
      .eq('user_id', id)
      .order('completed_at', { ascending: false })
      .limit(50);

    const plan = normalizePlan(user);
    const premium = plan !== 'free';
    const dailyBreakdownsLeft = premium
      ? -1
      : Math.max(0, FREE_DAILY_LIMIT - (user.daily_breakdowns || 0));

    const dailyCoinsEarned = user.daily_coins_date === getTodayStr()
      ? (user.daily_coins_earned || 0)
      : 0;

    return {
      id,
      telegramId: user.telegram_id || id,
      credits: user.credits,
      streak: user.streak,
      lastStreak: user.last_streak,
      todaySessions: user.today_sessions,
      lastActiveDay: user.last_active_day,
      totalCompleted: user.total_completed,
      isPremium: premium,
      isPro: plan === 'pro',
      premiumExpiry: user.premium_expiry,
      plan,
      dailyBreakdowns: user.daily_breakdowns,
      taskCountToday: user.task_count_today ?? user.daily_breakdowns,
      dailyBreakdownDate: user.daily_breakdown_date,
      history: plan === 'free'
        ? []
        : (history || []).map(h => ({ title: h.title, completedAt: h.completed_at })),
      dailyBreakdownsLeft,
      freeLimit: FREE_DAILY_LIMIT,
      coins: user.coins || 0,
      dailyCoinsEarned,
      dailyCoinLimit: DAILY_COIN_LIMIT,
    };
  } catch (err) {
    console.error(`[DB] getUser(${id}) failed:`, err.message);
    return defaultUserResponse(id);
  }
}

export async function addSession(id, taskTitle) {
  if (!supabase) return defaultUserResponse(id);

  try {
    const user = await getOrCreateUser(id);
    const today = getTodayStr();
    const diff = getDayDiffFromToday(user.last_active_day);

    const updates = { total_completed: (user.total_completed || 0) + 1 };

    if (diff === 0) {
      updates.today_sessions = (user.today_sessions || 0) + 1;
    } else if (diff === 1) {
      updates.last_streak = user.streak;
      updates.streak = (user.streak || 0) + 1;
      updates.last_active_day = today;
      updates.today_sessions = 1;
    } else {
      updates.last_streak = user.streak;
      updates.streak = 1;
      updates.last_active_day = today;
      updates.today_sessions = 1;
    }

    const plan = normalizePlan(user);
    const writes = [
      supabase.from('users').update(updates).eq('id', id),
    ];

    // Free plan has no history saving by design.
    if (plan !== 'free') {
      writes.push(supabase.from('sessions').insert({ user_id: id, title: taskTitle }));
    }

    const [userWrite, historyWrite] = await Promise.all(writes);
    const updateErr = userWrite?.error;
    const insertErr = historyWrite?.error;

    if (updateErr) throw updateErr;
    if (insertErr) throw insertErr;

    return getUser(id);
  } catch (err) {
    console.error(`[DB] addSession(${id}) failed:`, err.message);
    return defaultUserResponse(id);
  }
}

export async function updateCredits(id, amount) {
  if (!supabase) return 10;

  try {
    const user = await getOrCreateUser(id);
    const maxCredits = normalizePlan(user) === 'free' ? FREE_MAX_CREDITS : PREMIUM_MAX_CREDITS;
    const newCredits = Math.max(0, Math.min((user.credits || 0) + amount, maxCredits));
    const { error } = await supabase.from('users').update({ credits: newCredits }).eq('id', id);
    if (error) throw error;
    return newCredits;
  } catch (err) {
    console.error(`[DB] updateCredits(${id}) failed:`, err.message);
    return 10;
  }
}

export async function clearHistory(id) {
  if (!supabase) return [];

  try {
    const { error } = await supabase.from('sessions').delete().eq('user_id', id);
    if (error) throw error;
    return [];
  } catch (err) {
    console.error(`[DB] clearHistory(${id}) failed:`, err.message);
    return [];
  }
}

export async function checkAndIncrementBreakdown(id) {
  if (!supabase) return { allowed: true, dailyBreakdowns: 0, isPremium: false, plan: 'free' };

  try {
    const user = await getOrCreateUser(id);
    const today = getTodayStr();
    const plan = normalizePlan(user);
    const premium = plan !== 'free';

    let daily = user.daily_breakdown_date !== today ? 0 : (user.daily_breakdowns || 0);

    if (!premium && daily >= FREE_DAILY_LIMIT) {
      return { allowed: false, dailyBreakdowns: daily, isPremium: false };
    }

    const { error } = await supabase
      .from('users')
      .update({ daily_breakdowns: daily + 1, task_count_today: daily + 1, daily_breakdown_date: today })
      .eq('id', id);
    if (error) throw error;

    return { allowed: true, dailyBreakdowns: daily + 1, isPremium: premium, plan };
  } catch (err) {
    console.error(`[DB] checkAndIncrementBreakdown(${id}) failed:`, err.message);
    return { allowed: true, dailyBreakdowns: 0, isPremium: false, plan: 'free' };
  }
}

export async function setUserPlan(id, plan = 'starter') {
  if (!supabase) throw new Error('Database not configured');
  const normalized = (plan === 'pro' || plan === 'starter') ? plan : 'starter';

  const updates = {
    is_premium: true,
    premium_expiry: null,
    plan: normalized,
  };

  // Give paid users a healthy credit buffer for immediate activation.
  if (normalized === 'pro') updates.credits = 100;
  else updates.credits = 50;

  const { error } = await supabase.from('users').update(updates).eq('id', id);
  if (error) throw error;
  return getUser(id);
}

export async function setPremium(id, months) {
  // Backward compatibility wrapper.
  const plan = months === -1 || months === 12 ? 'pro' : 'starter';
  return setUserPlan(id, plan);
}

// Idempotent payment recorder.
// Returns { inserted: true } on first processing, { inserted: false } on duplicate.
export async function recordPayment(payment) {
  if (!supabase) return { inserted: true };

  const { error } = await supabase
    .from('payments')
    .insert(payment);

  if (!error) return { inserted: true };
  if (error.code === '23505') return { inserted: false }; // unique violation
  throw error;
}

export async function restoreStreak(id) {  if (!supabase) throw new Error('Database not configured');
  const user = await getOrCreateUser(id);
  if (normalizePlan(user) !== 'pro') throw new Error('Streak restore requires Pro \u2b50');

  const { error } = await supabase
    .from('users')
    .update({ streak: user.last_streak || 1, last_active_day: getTodayStr() })
    .eq('id', id);
  if (error) throw error;

  return getUser(id);
}

// ── Ad Reward system ──────────────────────────────────────

/**
 * Award coins to a user after completing a rewarded ad.
 *
 * Idempotency windows:
 *   < SAME_AD_WINDOW_SECONDS  → same ad claimed twice (AdsGram server + client both fired)
 *                               → return success with current balance, no double-credit
 *   SAME_AD_WINDOW_SECONDS .. AD_COOLDOWN_SECONDS → genuine cooldown, reject with COOLDOWN
 *   > AD_COOLDOWN_SECONDS    → new ad, award coins
 *
 * Returns { coins, coinsEarned, totalCoinsToday, dailyLimit, cooldownSeconds, alreadyCredited? }
 */
export async function rewardAd(userId, coins = COINS_PER_AD) {
  if (!supabase) {
    // Dev / offline mode — return mock success so frontend works without DB
    return {
      coins,
      coinsEarned: coins,
      totalCoinsToday: coins,
      dailyLimit: DAILY_COIN_LIMIT,
      cooldownSeconds: AD_COOLDOWN_SECONDS,
    };
  }

  const user = await getOrCreateUser(userId);
  const today = getTodayStr();
  const now = new Date();

  // ── Query most recent reward for this user ──
  const { data: recent } = await supabase
    .from('ad_rewards')
    .select('rewarded_at, coins_earned')
    .eq('user_id', userId)
    .order('rewarded_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (recent) {
    const secondsSince = (now - new Date(recent.rewarded_at)) / 1000;

    if (secondsSince < SAME_AD_WINDOW_SECONDS) {
      // Same ad: both AdsGram server callback AND client callback fired.
      // Coins already credited once — return success idempotently without double-crediting.
      const dailyCoins = user.daily_coins_date === today ? (user.daily_coins_earned || 0) : 0;
      return {
        coins: user.coins || 0,
        coinsEarned: recent.coins_earned || coins, // show the amount that WAS earned
        totalCoinsToday: dailyCoins,
        dailyLimit: DAILY_COIN_LIMIT,
        cooldownSeconds: Math.ceil(AD_COOLDOWN_SECONDS - secondsSince),
        alreadyCredited: true,
      };
    }

    if (secondsSince < AD_COOLDOWN_SECONDS) {
      const waitSeconds = Math.ceil(AD_COOLDOWN_SECONDS - secondsSince);
      const err = new Error(`Please wait ${waitSeconds}s before watching another ad`);
      err.code = 'COOLDOWN';
      err.waitSeconds = waitSeconds;
      throw err;
    }
  }

  // ── Daily limit check ──
  const dailyCoins = user.daily_coins_date === today ? (user.daily_coins_earned || 0) : 0;
  if (dailyCoins >= DAILY_COIN_LIMIT) {
    const err = new Error('Daily coin limit reached. Come back tomorrow!');
    err.code = 'DAILY_LIMIT';
    throw err;
  }

  const newCoins = (user.coins || 0) + coins;
  const newDailyCoins = dailyCoins + coins;

  // ── Write coins update + audit record atomically (best-effort) ──
  const [coinsUpdate, rewardInsert] = await Promise.all([
    supabase.from('users').update({
      coins: newCoins,
      daily_coins_earned: newDailyCoins,
      daily_coins_date: today,
    }).eq('id', userId),
    supabase.from('ad_rewards').insert({
      user_id: userId,
      ad_source: 'adsgram',
      coins_earned: coins,
    }),
  ]);

  if (coinsUpdate.error) throw coinsUpdate.error;
  if (rewardInsert.error) throw rewardInsert.error;

  return {
    coins: newCoins,
    coinsEarned: coins,
    totalCoinsToday: newDailyCoins,
    dailyLimit: DAILY_COIN_LIMIT,
    cooldownSeconds: AD_COOLDOWN_SECONDS,
  };
}

/**
 * Return top N users by coin balance for the leaderboard.
 */
export async function getLeaderboard(limit = 10) {
  if (!supabase) return [];

  try {
    const { data, error } = await supabase
      .from('users')
      .select('id, telegram_id, coins')
      .order('coins', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return (data || []).map((u, i) => ({
      rank: i + 1,
      userId: u.id,
      telegramId: u.telegram_id || u.id,
      coins: u.coins || 0,
    }));
  } catch (err) {
    console.error('[DB] getLeaderboard failed:', err.message);
    return [];
  }
}