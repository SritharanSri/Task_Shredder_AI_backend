import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const DB_FILE = path.join(process.cwd(), 'database.json');

async function getDB() {
  if (!existsSync(DB_FILE)) {
    await fs.writeFile(DB_FILE, JSON.stringify({ users: {}, history: [] }));
  }
  return JSON.parse(await fs.readFile(DB_FILE, 'utf-8'));
}

async function saveDB(data) {
  await fs.writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

// ── Helpers ──────────────────────────────
function getTodayStr() {
  return new Date().toISOString().split('T')[0];
}

function getDayDiffFromToday(dateStr) {
  if (!dateStr) return Infinity;
  const today = new Date(getTodayStr());
  const last = new Date(dateStr);
  return Math.round((today - last) / (1000 * 60 * 60 * 24));
}

export async function getUser(id) {
  const db = await getDB();
  if (!db.users[id]) {
    db.users[id] = { credits: 10, streak: 0, todaySessions: 0, lastActiveDay: null, totalCompleted: 0 };
    await saveDB(db);
  }

  // Update streak if missed a day
  const user = db.users[id];
  const diff = getDayDiffFromToday(user.lastActiveDay);
  let updated = false;

  if (diff > 1 && user.streak > 0) {
    user.streak = 0;
    updated = true;
  }
  if (diff !== 0 && user.todaySessions > 0) {
    user.todaySessions = 0;
    updated = true;
  }

  if (updated) {
    await saveDB(db);
  }

  const history = db.history.filter(h => h.user_id === id);
  return { ...user, id, history };
}

export async function addSession(id, taskTitle) {
  const db = await getDB();
  const user = db.users[id];
  if (!user) throw new Error("User not found");

  const today = getTodayStr();
  const diff = getDayDiffFromToday(user.lastActiveDay);

  if (diff === 0) {
    user.todaySessions += 1;
  } else if (diff === 1) {
    user.streak += 1;
    user.lastActiveDay = today;
    user.todaySessions = 1;
  } else {
    user.streak = 1;
    user.lastActiveDay = today;
    user.todaySessions = 1;
  }

  user.totalCompleted = (user.totalCompleted || 0) + 1;

  // Add to history
  db.history.push({
    id: Date.now().toString(),
    user_id: id,
    title: taskTitle,
    completedAt: new Date().toISOString()
  });

  await saveDB(db);
  return getUser(id);
}

export async function updateCredits(id, amount) {
  const db = await getDB();
  if (!db.users[id]) throw new Error("User not found");
  
  db.users[id].credits = Math.max(0, Math.min(db.users[id].credits + amount, 100)); // cap at 100
  await saveDB(db);
  return db.users[id].credits;
}

export async function clearHistory(id) {
  const db = await getDB();
  db.history = db.history.filter(h => h.user_id !== id);
  await saveDB(db);
  return [];
}
