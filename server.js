const express = require("express");
const session = require("express-session");
const SQLiteStoreFactory = require("connect-sqlite3");
const Database = require("better-sqlite3");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === "production";
const DATA_DIR = path.resolve(process.env.DATA_DIR || "./data");
const SESSION_SECRET = process.env.SESSION_SECRET;

if (!SESSION_SECRET || SESSION_SECRET.length < 32) {
  console.error("Set SESSION_SECRET to a random value at least 32 characters long.");
  process.exit(1);
}
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "tracker.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  pc_balance INTEGER NOT NULL DEFAULT 0 CHECK(pc_balance >= 0),
  secondary_balance INTEGER NOT NULL DEFAULT 0 CHECK(secondary_balance >= 0 AND secondary_balance < 150000),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  incoming INTEGER NOT NULL,
  pc_added INTEGER NOT NULL,
  secondary_added INTEGER NOT NULL,
  split_triggered INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_transactions_user_date ON transactions(user_id, id DESC);
`);

const SQLiteStore = SQLiteStoreFactory(session);
app.set("trust proxy", IS_PROD ? 1 : false);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "20kb" }));
app.use(session({
  store: new SQLiteStore({ db: "sessions.sqlite", dir: DATA_DIR, concurrentDB: true }),
  name: "pc_tracker_session",
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: "lax",
    maxAge: 14 * 24 * 60 * 60 * 1000
  }
}));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: "draft-7", legacyHeaders: false,
  message: { error: "Too many attempts. Please wait 15 minutes and try again." } });

const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const cleanUser = u => ({ id: u.id, username: u.username, pcBalance: u.pc_balance, secondaryBalance: u.secondary_balance });
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Please sign in." });
  next();
}
function validUsername(v) {
  return typeof v === "string" && /^[A-Za-z0-9_]{3,24}$/.test(v);
}
function validCode(v) {
  return typeof v === "string" && v.length >= 8 && v.length <= 128;
}
function safeInt(v) {
  return Number.isSafeInteger(v) && v >= 0;
}
function getUser(id) {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id);
}
function calculate(income, secondary) {
  const needed = 150000 - secondary;
  if (income < needed) {
    return { pcAdded: 0, secondaryAdded: income, endingSecondary: secondary + income, splitTriggered: false };
  }
  // Threshold is filled; Rp150,000 is split Rp75,000 / Rp75,000.
  // Every rupiah left from this same incoming amount goes directly to PC funds.
  return {
    pcAdded: 75000 + (income - needed),
    secondaryAdded: needed,
    endingSecondary: 75000,
    splitTriggered: true
  };
}

app.post("/api/register", authLimiter, asyncRoute(async (req, res) => {
  const { username, accessCode } = req.body || {};
  if (!validUsername(username)) return res.status(400).json({ error: "Username must be 3–24 characters: letters, numbers or underscores." });
  if (!validCode(accessCode)) return res.status(400).json({ error: "Access code must be 8–128 characters." });
  // Use Node's built-in scrypt with a unique salt; no plaintext access code is stored.
  const salt = crypto.randomBytes(16);
  const derived = await new Promise((resolve, reject) => crypto.scrypt(accessCode, salt, 64, (e, key) => e ? reject(e) : resolve(key)));
  const stored = `scrypt$${salt.toString("hex")}$${Buffer.from(derived).toString("hex")}`;
  try {
    const result = db.prepare("INSERT INTO users(username, password_hash) VALUES(?, ?)").run(username, stored);
    req.session.regenerate(err => {
      if (err) return res.status(500).json({ error: "Could not start your session." });
      req.session.userId = Number(result.lastInsertRowid);
      res.json({ user: cleanUser(getUser(req.session.userId)) });
    });
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) return res.status(409).json({ error: "That username is already taken." });
    throw e;
  }
}));

async function verifyCode(code, stored) {
  if (typeof code !== "string" || !stored) return false;
  const [scheme, saltHex, hashHex] = stored.split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = await new Promise((resolve, reject) => crypto.scrypt(code, salt, expected.length, (e, key) => e ? reject(e) : resolve(key)));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

app.post("/api/login", authLimiter, asyncRoute(async (req, res) => {
  const { username, accessCode } = req.body || {};
  if (typeof username !== "string" || typeof accessCode !== "string") return res.status(400).json({ error: "Enter your username and access code." });
  const user = db.prepare("SELECT * FROM users WHERE username = ? COLLATE NOCASE").get(username);
  if (!user || !(await verifyCode(accessCode, user.password_hash))) return res.status(401).json({ error: "Incorrect username or access code." });
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: "Could not start your session." });
    req.session.userId = user.id;
    res.json({ user: cleanUser(getUser(user.id)) });
  });
}));

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("pc_tracker_session", { httpOnly: true, sameSite: "lax", secure: IS_PROD });
    res.json({ ok: true });
  });
});
app.get("/api/me", requireAuth, (req, res) => {
  const user = getUser(req.session.userId);
  if (!user) return req.session.destroy(() => res.status(401).json({ error: "Account not found." }));
  res.json({ user: cleanUser(user) });
});

app.post("/api/credentials", requireAuth, authLimiter, asyncRoute(async (req, res) => {
  const { currentAccessCode, newUsername, newAccessCode } = req.body || {};
  const user = getUser(req.session.userId);
  if (!user || !(await verifyCode(currentAccessCode, user.password_hash))) return res.status(403).json({ error: "Previous access code is incorrect." });
  if (newUsername !== undefined) {
    if (!validUsername(newUsername)) return res.status(400).json({ error: "Username must be 3–24 characters: letters, numbers or underscores." });
    try { db.prepare("UPDATE users SET username = ? WHERE id = ?").run(newUsername, user.id); }
    catch (e) { if (String(e.message).includes("UNIQUE")) return res.status(409).json({ error: "That username is already taken." }); throw e; }
  }
  if (newAccessCode !== undefined) {
    if (!validCode(newAccessCode)) return res.status(400).json({ error: "New access code must be 8–128 characters." });
    const salt = crypto.randomBytes(16);
    const derived = await new Promise((resolve, reject) => crypto.scrypt(newAccessCode, salt, 64, (e, key) => e ? reject(e) : resolve(key)));
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(`scrypt$${salt.toString("hex")}$${Buffer.from(derived).toString("hex")}`, user.id);
  }
  res.json({ user: cleanUser(getUser(user.id)) });
}));

app.post("/api/starting-balances", requireAuth, (req, res) => {
  const { pcBalance, secondaryBalance } = req.body || {};
  if (!safeInt(pcBalance) || !safeInt(secondaryBalance) || secondaryBalance >= 150000) {
    return res.status(400).json({ error: "PC balance must be a non-negative whole number. Secondary balance must be from Rp0 to Rp149,999." });
  }
  db.prepare("UPDATE users SET pc_balance = ?, secondary_balance = ? WHERE id = ?").run(pcBalance, secondaryBalance, req.session.userId);
  res.json({ user: cleanUser(getUser(req.session.userId)) });
});

app.post("/api/transactions", requireAuth, (req, res) => {
  const { incoming, note = "" } = req.body || {};
  if (!Number.isSafeInteger(incoming) || incoming <= 0 || incoming > 1000000000000) return res.status(400).json({ error: "Enter a valid positive whole-number amount." });
  if (typeof note !== "string" || note.length > 60) return res.status(400).json({ error: "Note must be 60 characters or fewer." });
  const user = getUser(req.session.userId);
  const result = calculate(incoming, user.secondary_balance);
  const tx = db.transaction(() => {
    db.prepare("UPDATE users SET pc_balance = pc_balance + ?, secondary_balance = ? WHERE id = ?")
      .run(result.pcAdded, result.endingSecondary, user.id);
    db.prepare("INSERT INTO transactions(user_id,incoming,pc_added,secondary_added,split_triggered,note) VALUES(?,?,?,?,?,?)")
      .run(user.id, incoming, result.pcAdded, result.secondaryAdded, result.splitTriggered ? 1 : 0, note.trim());
  });
  tx();
  res.json({ user: cleanUser(getUser(user.id)), distribution: result });
});

app.get("/api/transactions", requireAuth, (req, res) => {
  const rows = db.prepare("SELECT id,incoming,pc_added,secondary_added,split_triggered,note,created_at FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 100").all(req.session.userId);
  res.json({ transactions: rows });
});

app.use(express.static(path.join(__dirname, "public"), {
  etag: false, lastModified: false, maxAge: 0,
  setHeaders: (res) => res.setHeader("Cache-Control", "no-store")
}));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html"), {
  headers: { "Cache-Control": "no-store" }
}));
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

app.listen(PORT, () => console.log(`PC Savings Tracker running on port ${PORT}`));
