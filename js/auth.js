/* ============================================
   QuizApp — auth layer
   --------------------------------------------
   Accounts live in this browser's localStorage.
   There is no server, so this keeps people out
   of each other's saved progress on a shared
   device -- it is not real security.

   Every function below is async so that swapping
   in a real backend later only means rewriting
   this file.
   ============================================ */

const USERS_KEY = "quizapp.users";
const SESSION_KEY = "quizapp.session";

/* --- storage helpers --- */

function loadUsers() {
  try {
    return JSON.parse(localStorage.getItem(USERS_KEY)) || {};
  } catch {
    return {};
  }
}

function saveUsers(users) {
  localStorage.setItem(USERS_KEY, JSON.stringify(users));
}

/* --- password hashing ---
   Passwords are never written to disk in plain text.
   A per-account random salt means two people with the
   same password get different stored hashes. */

function randomSalt() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password, salt) {
  const data = new TextEncoder().encode(salt + ":" + password);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/* --- validation --- */

function normalizeUsername(raw) {
  return String(raw || "").trim().toLowerCase();
}

function validateUsername(name) {
  if (name.length < 3) return "Username must be at least 3 characters.";
  if (name.length > 20) return "Username must be 20 characters or fewer.";
  if (!/^[a-z0-9_]+$/.test(name)) {
    return "Username can only use letters, numbers and underscores.";
  }
  return null;
}

function validatePassword(password) {
  if (password.length < 6) return "Password must be at least 6 characters.";
  return null;
}

/* --- public API --- */

export async function signUp(rawUsername, password, confirmPassword) {
  const username = normalizeUsername(rawUsername);

  const nameError = validateUsername(username);
  if (nameError) throw new Error(nameError);

  const passError = validatePassword(password);
  if (passError) throw new Error(passError);

  if (password !== confirmPassword) {
    throw new Error("Those passwords don't match.");
  }

  const users = loadUsers();
  if (users[username]) {
    throw new Error("That username is already taken.");
  }

  const salt = randomSalt();
  users[username] = {
    username,
    displayName: String(rawUsername).trim(),
    salt,
    hash: await hashPassword(password, salt),
    createdAt: new Date().toISOString(),
  };
  saveUsers(users);

  return startSession(username);
}

export async function logIn(rawUsername, password) {
  const username = normalizeUsername(rawUsername);
  const user = loadUsers()[username];

  // Same message either way, so this can't be used to
  // discover which usernames exist.
  const rejection = new Error("Wrong username or password.");
  if (!user) throw rejection;

  const hash = await hashPassword(password, user.salt);
  if (hash !== user.hash) throw rejection;

  return startSession(username);
}

export function startSession(username) {
  const session = { username, since: Date.now() };
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

export function currentUser() {
  try {
    const session = JSON.parse(localStorage.getItem(SESSION_KEY));
    if (!session?.username) return null;
    return loadUsers()[session.username] || null;
  } catch {
    return null;
  }
}

export function logOut() {
  localStorage.removeItem(SESSION_KEY);
}

/* Guests get a session without an account, so they can
   join a game without signing up. */
export function playAsGuest() {
  const suffix = Math.floor(1000 + Math.random() * 9000);
  const username = "guest_" + suffix;

  const users = loadUsers();
  users[username] = {
    username,
    displayName: "Guest " + suffix,
    guest: true,
    createdAt: new Date().toISOString(),
  };
  saveUsers(users);

  return startSession(username);
}
