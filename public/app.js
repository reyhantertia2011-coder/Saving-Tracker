const $ = id => document.getElementById(id);
const fmt = n => "Rp" + Number(n).toLocaleString("id-ID");
let authMode = "login";
let pendingTransaction = null;
let currentUser = null;
let currentVersion = "1.0.0";
let updateInfo = null;

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}
function message(id, text, kind = "") {
  const el = $(id); el.textContent = text; el.className = "message " + kind;
}
function setAuthMode(mode) {
  authMode = mode;
  $("loginTab").classList.toggle("active", mode === "login");
  $("registerTab").classList.toggle("active", mode === "register");
  $("authSubmit").textContent = mode === "login" ? "Sign in" : "Create account";
  $("authHint").textContent = mode === "login"
    ? "Sign in with your username and access code."
    : "Choose a username (3–24 characters) and an access code of at least 8 characters.";
  $("authCode").autocomplete = mode === "login" ? "current-password" : "new-password";
  message("authMessage", "");
}
function showDashboard(user) {
  currentUser = user;
  $("authView").classList.add("hidden");
  $("dashboard").classList.remove("hidden");
  $("welcomeUser").textContent = user.username;
  $("settings").classList.add("hidden");
  renderBalances(user);
  loadHistory();
}
function renderBalances(user) {
  $("pcBalance").textContent = fmt(user.pcBalance);
  $("secondaryBalance").textContent = fmt(user.secondaryBalance);
  const pct = Math.min(100, user.pcBalance / 10000000 * 100);
  $("progressBar").style.width = pct + "%";
  $("progressText").textContent = `${pct.toFixed(1)}% of Rp10,000,000 · ${fmt(Math.max(0, 10000000-user.pcBalance))} remaining`;
  $("secondaryBar").style.width = Math.min(100, user.secondaryBalance / 150000 * 100) + "%";
  $("editPc").value = user.pcBalance;
  $("editSecondary").value = user.secondaryBalance;
}
async function loadHistory() {
  try {
    const { transactions } = await api("/api/transactions");
    if (!transactions.length) { $("history").innerHTML = '<p class="muted">No transactions yet.</p>'; return; }
    $("history").innerHTML = `<table><thead><tr><th>Date</th><th>Incoming</th><th>PC added</th><th>Secondary added</th><th>Note</th></tr></thead><tbody>${
      transactions.map(t => `<tr><td>${new Date(t.created_at + "Z").toLocaleString()}</td><td>${fmt(t.incoming)}</td><td class="green">${fmt(t.pc_added)}</td><td>${fmt(t.secondary_added)}</td><td>${escapeHtml(t.note || "—")}${t.split_triggered ? " · split" : ""}</td></tr>`).join("")
    }</tbody></table>`;
  } catch (e) { $("history").textContent = e.message; }
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}
$("loginTab").addEventListener("click", () => setAuthMode("login"));
$("registerTab").addEventListener("click", () => setAuthMode("register"));
$("authForm").addEventListener("submit", async e => {
  e.preventDefault(); $("authSubmit").disabled = true; message("authMessage", "");
  try {
    const endpoint = authMode === "login" ? "/api/login" : "/api/register";
    const result = await api(endpoint, { method:"POST", body:JSON.stringify({ username:$("authUsername").value.trim(), accessCode:$("authCode").value }) });
    $("authForm").reset(); showDashboard(result.user);
  } catch (err) { message("authMessage", err.message, "error"); }
  finally { $("authSubmit").disabled = false; }
});
$("logoutBtn").addEventListener("click", async () => {
  try { await api("/api/logout", { method:"POST", body:"{}" }); }
  finally {
    currentUser = null; $("dashboard").classList.add("hidden"); $("settings").classList.add("hidden"); $("authView").classList.remove("hidden"); setAuthMode("login");
  }
});
$("transactionForm").addEventListener("submit", async e => {
  e.preventDefault(); pendingTransaction = null; $("confirmTransaction").classList.add("hidden");
  const incoming = Number($("incoming").value);
  if (!Number.isSafeInteger(incoming) || incoming <= 0) { $("preview").textContent = "Enter a positive whole-number amount."; return; }
  try {
    const user = (await api("/api/me")).user;
    const needed = 150000 - user.secondaryBalance;
    let pcAdded = 0, secondaryAdded = incoming, endingSecondary = user.secondaryBalance + incoming, split = false;
    if (incoming >= needed) { pcAdded = 75000 + incoming - needed; secondaryAdded = needed; endingSecondary = 75000; split = true; }
    pendingTransaction = { incoming, note:$("note").value.trim(), pcAdded };
    $("preview").innerHTML = `<div class="preview-grid">
      <div><span class="tiny muted">To secondary</span><strong>${fmt(secondaryAdded)}</strong></div>
      <div><span class="tiny muted">To PC fund</span><strong class="green">${fmt(pcAdded)}</strong></div>
      <div><span class="tiny muted">Secondary after</span><strong>${fmt(endingSecondary)}</strong></div>
    </div><p class="tiny muted">${split ? "Threshold reached. Rp150,000 is split into Rp75,000 for PC and Rp75,000 retained. All remaining incoming money goes to PC." : "Threshold not reached. This incoming amount goes entirely to secondary savings."}</p>`;
    $("confirmTransaction").classList.remove("hidden"); message("transactionMessage", "");
  } catch (err) { message("transactionMessage", err.message, "error"); }
});
$("confirmTransaction").addEventListener("click", async () => {
  if (!pendingTransaction) return;
  $("confirmTransaction").disabled = true;
  try {
    const result = await api("/api/transactions", { method:"POST", body:JSON.stringify(pendingTransaction) });
    showDashboard(result.user); $("transactionForm").reset(); pendingTransaction = null;
    $("preview").textContent = "Transaction saved successfully."; $("confirmTransaction").classList.add("hidden");
    message("transactionMessage", "Transaction saved.", "success");
  } catch (err) { message("transactionMessage", err.message, "error"); }
  finally { $("confirmTransaction").disabled = false; }
});
$("refreshHistory").addEventListener("click", loadHistory);
$("settingsBtn").addEventListener("click", () => $("settings").classList.remove("hidden"));
$("closeSettings").addEventListener("click", () => $("settings").classList.add("hidden"));
$("credentialsForm").addEventListener("submit", async e => {
  e.preventDefault();
  const payload = { currentAccessCode:$("currentCode").value };
  if ($("newUsername").value.trim()) payload.newUsername = $("newUsername").value.trim();
  if ($("newCode").value) payload.newAccessCode = $("newCode").value;
  if (!payload.newUsername && !payload.newAccessCode) { message("settingsMessage", "Enter a new username or access code.", "error"); return; }
  try {
    const { user } = await api("/api/credentials", { method:"POST", body:JSON.stringify(payload) });
    showDashboard(user); $("credentialsForm").reset(); message("settingsMessage", "Credentials updated.", "success");
  } catch (err) { message("settingsMessage", err.message, "error"); }
});
$("balancesForm").addEventListener("submit", async e => {
  e.preventDefault();
  try {
    const { user } = await api("/api/starting-balances", { method:"POST", body:JSON.stringify({ pcBalance:Number($("editPc").value), secondaryBalance:Number($("editSecondary").value) }) });
    showDashboard(user); message("settingsMessage", "Balances updated.", "success");
  } catch (err) { message("settingsMessage", err.message, "error"); }
});

async function checkForUpdate(showNoUpdate = false) {
  try {
    const response = await fetch("/version.json?check=" + Date.now(), { cache:"no-store" });
    if (!response.ok) throw new Error("Could not check for updates.");
    const remote = await response.json();
    if (!remote.version) throw new Error("Version information is invalid.");
    if (remote.version !== currentVersion && compareVersions(remote.version, currentVersion) > 0) {
      updateInfo = remote;
      $("updateSummary").textContent = `Version ${remote.version} is available. You're currently using ${currentVersion}.`;
      $("updateChanges").innerHTML = (remote.changelog || ["Website improvements and fixes."]).map(x => `<li>${escapeHtml(x)}</li>`).join("");
      $("updateBanner").classList.remove("hidden");
    } else if (showNoUpdate) {
      alert("You're already using the latest version (" + currentVersion + ").");
    }
  } catch (e) { if (showNoUpdate) alert(e.message); }
}
function compareVersions(a,b) {
  const aa=String(a).split(".").map(Number), bb=String(b).split(".").map(Number);
  for(let i=0;i<Math.max(aa.length,bb.length);i++){const d=(aa[i]||0)-(bb[i]||0);if(d)return d;}
  return 0;
}
$("laterUpdate").addEventListener("click", () => $("updateBanner").classList.add("hidden"));
$("applyUpdate").addEventListener("click", async () => {
  $("applyUpdate").disabled = true;
  try {
    // The host has already deployed the new frontend. Reloading fetches the latest no-cache assets.
    await fetch("/version.json?apply=" + Date.now(), { cache:"no-store" });
    location.reload();
  } finally { $("applyUpdate").disabled = false; }
});
$("checkUpdate").addEventListener("click", () => checkForUpdate(true));

(async function init() {
  try {
    const versionResponse = await fetch("/version.json", { cache:"no-store" });
    const versionData = await versionResponse.json();
    currentVersion = versionData.version || "1.0.0";
    $("version").textContent = "v" + currentVersion;
  } catch {}
  $("checkUpdate").classList.remove("hidden");
  try { const { user } = await api("/api/me"); showDashboard(user); }
  catch { $("authView").classList.remove("hidden"); }
  checkForUpdate(false);
  setInterval(() => checkForUpdate(false), 60000);
})();
