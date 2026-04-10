import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ── Free tier constants ───────────────────────────────────
export const FREE_DAILY_LIMIT = 3;
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

async function getOrCreateUser(id) {
  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', id)
    .single();

  if (error && error.code === 'PGRST116') {
    const { data: newUser, error: insertErr } = await supabase
      .from('users')
      .insert({ id })
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

  const premium = isPremiumActive(user);
  const dailyBreakdownsLeft = premium
    ? -1
    : Math.max(0, FREE_DAILY_LIMIT - (user.daily_breakdowns || 0));

  return {
    id,
    credits: user.credits,
    streak: user.streak,
    lastStreak: user.last_streak,
    todaySessions: user.today_sessions,
    lastActiveDay: user.last_active_day,
    totalCompleted: user.total_completed,
    isPremium: premium,
    premiumExpiry: user.premium_expiry,
    dailyBreakdowns: user.daily_breakdowns,
    dailyBreakdownDate: user.daily_breakdown_date,
    history: (history || []).map(h => ({ title: h.title, completedAt: h.completed_at })),
    dailyBreakdownsLeft,
    freeLimit: FREE_DAILY_LIMIT,
  };
}

export async function addSession(id, taskTitle) {
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

  const [{ error: updateErr }, { error: insertErr }] = await Promise.all([
    supabase.from('users').update(updates).eq('id', id),
    supabase.from('sessions').insert({ user_id: id, title: taskTitle }),
  ]);

  if (updateErr) throw updateErr;
  if (insertErr) throw insertErr;

  return getUser(id);
}

export async function updateCredits(id, amount) {
  const user = await getOrCreateUser(id);
  const maxCredits = isPremiumActive(user) ? PREMIUM_MAX_CREDITS : FREE_MAX_CREDITS;
  const newCredits = Math.max(0, Math.min((user.credits || 0) + amount, maxCredits));
  const { error } = await supabase.from('users').update({ credits: newCredits }).eq('id', id);
  if (error) throw error;
  return newCredits;
}

export async function clearHistory(id) {
  const { error } = await supabase.from('sessions').delete().eq('user_id', id);
  if (error) throw error;
  return [];
}

export async function checkAndIncrementBreakdown(id) {
  const user = await getOrCreateUser(id);
  const today = getTodayStr();
  const premium = isPremiumActive(user);

  let daily = user.daily_breakdown_date !== today ? 0 : (user.daily_breakdowns || 0);

  if (!premium && daily >= FREE_DAILY_LIMIT) {
    return { allowed: false, dailyBreakdowns: daily, isPremium: false };
  }

  const { error } = await supabase
    .from('users')
    .update({ daily_breakdowns: daily + 1, daily_breakdown_date: today })
    .eq('id', id);
  if (error) throw error;

  return { allowed: true, dailyBreakdowns: daily + 1, isPremium: premium };
}

export async function setPremium(id, months) {
  const user = await getOrCreateUser(id);
  const updates = { is_premium: true };

  if (months === -1) {
    updates.premium_expiry = null;
  } else {
    const base = (user.premium_expiry && new Date(user.premium_expiry) > new Date())
      ? new Date(user.premium_expiry)
      : new Date();
    base.setMonth(base.getMonth() + months);
    updates.premium_expiry = base.toISOString();
  }

  if ((user.credits || 0) < 50) updates.credits = 50;

  const { error } = await supabase.from('users').update(updates).eq('id', id);
  if (error) throw error;

  return getUser(id);
}

export async function restoreStreak(id) {
  const user = await getOrCreateUser(id);
  if (!isPremiumActive(user)) throw new Error('Streak restore requires Premium \u2b50');

  const { error } = await supabase
    .from('users')
    .update({ streak: user.last_streak || 1, last_active_day: getTodayStr() })
    .eq('id', id);
  if (error) throw error;

  return getUser(id);
}