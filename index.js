// Starts the bot (bot.js) and keeps it up to date from GitHub.
// Every minute it checks the repo; when the code changes it downloads it and restarts the bot.
// Only uses built-in Node features, so it runs even before `npm install`.
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');

const REPO = 'ivvybizness-lab/fortnite-bracket-bot';
const BRANCH = 'main';
const CHECK_EVERY_MS = 60 * 1000;
const FILES = ['bot.js', 'package.json'];
const STATE_FILE = path.join(__dirname, '.deployed-commit');
const here = file => path.join(__dirname, file);

let bot = null;
let updating = false;

function log(msg) { console.log(`[updater] ${msg}`); }

async function latestCommit() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`, {
    headers: { 'User-Agent': 'bracket-bot-updater', Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub said ${res.status}`);
  return (await res.json()).sha;
}

async function download(sha) {
  const out = {};
  for (const file of FILES) {
    const res = await fetch(`https://raw.githubusercontent.com/${REPO}/${sha}/${file}`);
    if (!res.ok) throw new Error(`Couldn't download ${file} (${res.status})`);
    out[file] = await res.text();
  }
  return out;
}

function installPackages() {
  log('Installing packages...');
  execSync('npm install --omit=dev --no-audit --no-fund', { cwd: __dirname, stdio: 'inherit' });
}

function startBot() {
  if (!fs.existsSync(here('bot.js'))) {
    log('bot.js is missing - waiting for the next update check.');
    return;
  }
  log('Starting bot...');
  bot = spawn(process.execPath, ['bot.js'], { cwd: __dirname, stdio: 'inherit' });
  bot.on('exit', code => {
    bot = null;
    if (updating) return;
    log(`Bot stopped (code ${code}). Restarting in 15 seconds...`);
    setTimeout(() => { if (!bot && !updating) startBot(); }, 15000);
  });
}

function stopBot() {
  return new Promise(resolve => {
    if (!bot) return resolve();
    const proc = bot;
    proc.once('exit', resolve);
    proc.kill();
    setTimeout(() => proc.kill('SIGKILL'), 5000);
  });
}

async function update() {
  if (updating) return;
  try {
    const sha = await latestCommit();
    const current = fs.existsSync(STATE_FILE) ? fs.readFileSync(STATE_FILE, 'utf8').trim() : '';
    if (sha === current) return;

    log(`New version found (${sha.slice(0, 7)}). Updating...`);
    const files = await download(sha);
    const oldPkg = fs.existsSync(here('package.json')) ? fs.readFileSync(here('package.json'), 'utf8') : '';

    updating = true;
    await stopBot();
    for (const [file, text] of Object.entries(files)) fs.writeFileSync(here(file), text);
    if (files['package.json'] !== oldPkg || !fs.existsSync(here('node_modules'))) installPackages();
    fs.writeFileSync(STATE_FILE, sha);
    log('Update done.');
  } catch (e) {
    log(`Update check failed: ${e.message} (will try again)`);
  } finally {
    if (updating) { updating = false; startBot(); }
  }
}

(async () => {
  log(`Watching github.com/${REPO} for updates`);
  if (!fs.existsSync(here('node_modules'))) installPackages();
  await update();
  if (!bot) startBot();
  setInterval(update, CHECK_EVERY_MS);
})();
