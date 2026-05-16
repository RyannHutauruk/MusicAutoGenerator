/**
 * Simple Express web UI for Music Generator.
 * Minimal dashboard — just what's needed to trigger generation and monitor progress.
 */

import express from "express";
import path from "path";
import fs from "fs";
import { Orchestrator } from "../automation/orchestrator";
import { addSunoAccount, addUdioAccount, loadConfig } from "../storage/config";
import { listGenres, countTracks } from "../utils/helpers";
import { logger } from "../utils/logger";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

let orchestrator: Orchestrator | null = null;
let activeGeneration: { genre: string; promise: Promise<any> } | null = null;

// Serve static HTML
app.get("/", (_req, res) => {
  res.send(DASHBOARD_HTML);
});

// --- API endpoints ---

app.get("/api/status", (_req, res) => {
  const config = loadConfig();
  const genres = listGenres();
  const library = genres.map((g) => ({ genre: g, tracks: countTracks(g) }));
  const totalTracks = library.reduce((sum, g) => sum + g.tracks, 0);

  res.json({
    providers: {
      suno: {
        enabled: config.providers.suno.enabled,
        accounts: config.providers.suno.accounts.length,
        sessionAccounts: config.providers.suno.accounts.filter((a) => a.authType === "session").length,
        cookieAccounts: config.providers.suno.accounts.filter((a) => a.authType !== "session").length,
        useApi: config.providers.suno.useApi,
      },
      udio: {
        enabled: config.providers.udio.enabled,
        accounts: config.providers.udio.accounts.length,
      },
    },
    library,
    totalTracks,
    generating: activeGeneration
      ? { genre: activeGeneration.genre, stats: orchestrator?.getQueueStats() }
      : null,
  });
});

app.post("/api/generate", async (req, res) => {
  const { genre, count, duration, mood } = req.body;

  if (!genre || !count) {
    res.status(400).json({ error: "genre and count are required" });
    return;
  }

  if (activeGeneration) {
    res.status(409).json({ error: "Generation already in progress" });
    return;
  }

  orchestrator = new Orchestrator();

  // Preflight check: ensure at least one account is configured
  const config2 = loadConfig();
  const hasSuno = config2.providers.suno.enabled && config2.providers.suno.accounts.length > 0;
  const hasUdio = config2.providers.udio.enabled && config2.providers.udio.accounts.length > 0;
  if (!hasSuno && !hasUdio) {
    orchestrator = null;
    res.status(400).json({ error: "No accounts configured. Add a Suno or Udio account first (scroll down to 'Add Account')." });
    return;
  }

  activeGeneration = {
    genre,
    promise: orchestrator
      .generate({ genre, count: parseInt(count), duration: parseInt(duration) || 120, mood })
      .then((stats) => {
        logger.info(`Web: generation complete — ${JSON.stringify(stats)}`);
        activeGeneration = null;
        return stats;
      })
      .catch((e) => {
        logger.error(`Web: generation failed — ${e}`);
        activeGeneration = null;
      }),
  };

  res.json({ status: "started", genre, count });
});

app.get("/api/queue", (_req, res) => {
  if (!orchestrator) {
    res.json({ stats: null, jobs: [] });
    return;
  }
  res.json({
    stats: orchestrator.getQueueStats(),
    jobs: orchestrator.getJobs().map((j) => ({
      id: j.id,
      genre: j.options.genre,
      prompt: j.options.prompt,
      status: j.status,
      provider: j.provider,
      attempts: j.attempts,
      error: j.error,
      result: j.result
        ? { filePath: j.result.filePath, title: j.result.title }
        : null,
    })),
  });
});

app.post("/api/stop", (_req, res) => {
  if (orchestrator) {
    orchestrator.stop();
    activeGeneration = null;
  }
  res.json({ status: "stopped" });
});

app.post("/api/accounts", (req, res) => {
  const { provider, cookie } = req.body;
  if (!provider || !cookie) {
    res.status(400).json({ error: "provider and cookie required" });
    return;
  }
  try {
    if (provider === "suno") {
      const acc = addSunoAccount(cookie);
      res.json({ status: "added", account: acc.id });
    } else if (provider === "udio") {
      const acc = addUdioAccount(cookie);
      res.json({ status: "added", account: acc.id });
    } else {
      res.status(400).json({ error: `Unknown provider: ${provider}` });
    }
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/api/library", (_req, res) => {
  const libraryPath = path.resolve(process.cwd(), "music-library");
  const genres = listGenres();
  const result = genres.map((g) => {
    const genrePath = path.join(libraryPath, g);
    const tracks = fs
      .readdirSync(genrePath)
      .filter((f) => f.endsWith(".mp3"))
      .map((f) => {
        const stats = fs.statSync(path.join(genrePath, f));
        return {
          name: f,
          size: (stats.size / (1024 * 1024)).toFixed(2) + " MB",
          created: stats.birthtime.toISOString(),
        };
      });
    return { genre: g, tracks };
  });
  res.json(result);
});

// --- Inline dashboard HTML ---
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Music Generator</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #c9d1d9; padding: 2rem; max-width: 800px; margin: 0 auto; }
    h1 { color: #58a6ff; margin-bottom: 1.5rem; font-size: 1.6rem; }
    h2 { color: #8b949e; font-size: 1rem; margin: 1.5rem 0 0.5rem; text-transform: uppercase; letter-spacing: 0.05em; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1rem; margin-bottom: 1rem; }
    .row { display: flex; gap: 1rem; flex-wrap: wrap; }
    .row > * { flex: 1; min-width: 200px; }
    label { display: block; color: #8b949e; font-size: 0.85rem; margin-bottom: 0.25rem; }
    input, select { width: 100%; padding: 0.5rem; background: #0d1117; border: 1px solid #30363d; border-radius: 4px; color: #c9d1d9; font-size: 0.9rem; }
    input:focus, select:focus { outline: none; border-color: #58a6ff; }
    button { padding: 0.6rem 1.2rem; border: none; border-radius: 6px; cursor: pointer; font-size: 0.9rem; font-weight: 600; }
    .btn-primary { background: #238636; color: #fff; }
    .btn-primary:hover { background: #2ea043; }
    .btn-danger { background: #da3633; color: #fff; }
    .btn-danger:hover { background: #f85149; }
    .btn-secondary { background: #30363d; color: #c9d1d9; }
    .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 10px; font-size: 0.75rem; font-weight: 600; }
    .badge-green { background: #238636; color: #fff; }
    .badge-gray { background: #30363d; color: #8b949e; }
    .badge-blue { background: #1f6feb; color: #fff; }
    .progress { height: 6px; background: #30363d; border-radius: 3px; overflow: hidden; margin-top: 0.5rem; }
    .progress-bar { height: 100%; background: #238636; transition: width 0.3s; }
    .job-list { max-height: 300px; overflow-y: auto; }
    .job { display: flex; justify-content: space-between; align-items: center; padding: 0.5rem; border-bottom: 1px solid #21262d; font-size: 0.85rem; }
    .status-done { color: #3fb950; }
    .status-failed { color: #f85149; }
    .status-running { color: #d29922; }
    .status-pending { color: #8b949e; }
    .genre-chip { display: inline-block; background: #1f6feb22; color: #58a6ff; padding: 0.25rem 0.6rem; border-radius: 12px; font-size: 0.8rem; margin: 0.15rem; }
    #status-text { font-size: 0.85rem; color: #8b949e; margin-top: 0.5rem; }
    .account-form { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
    .account-form input { flex: 1; }
  </style>
</head>
<body>
  <h1>Music Generator</h1>

  <div class="card">
    <h2>Generate Music</h2>
    <form id="genForm" style="margin-top:0.5rem">
      <div class="row">
        <div><label>Genre / Topic</label><input id="genre" placeholder="e.g. lofi hip hop, slow blues" required></div>
        <div><label>Number of Songs</label><input id="count" type="number" value="5" min="1" required></div>
      </div>
      <div class="row" style="margin-top:0.75rem">
        <div><label>Duration</label>
          <select id="duration">
            <option value="60">Short (~1 min)</option>
            <option value="120" selected>Medium (~2 min)</option>
            <option value="180">Long (~3 min)</option>
          </select>
        </div>
        <div><label>Mood (optional)</label><input id="mood" placeholder="e.g. chill, dark, energetic"></div>
      </div>
      <div style="margin-top:1rem;display:flex;gap:0.5rem">
        <button type="submit" class="btn-primary" id="startBtn">Start Generation</button>
        <button type="button" class="btn-danger" id="stopBtn" style="display:none">Stop</button>
      </div>
    </form>
    <div id="progressArea" style="display:none;margin-top:1rem">
      <div class="progress"><div class="progress-bar" id="progressBar" style="width:0%"></div></div>
      <div id="status-text"></div>
    </div>
  </div>

  <div class="card">
    <h2>Queue</h2>
    <div class="job-list" id="jobList"><p style="color:#8b949e;font-size:0.85rem">No active jobs</p></div>
  </div>

  <div class="card">
    <h2>Music Library</h2>
    <div id="library"><p style="color:#8b949e;font-size:0.85rem">Loading...</p></div>
  </div>

  <div class="card">
    <h2>Add Account</h2>
    <div style="margin-bottom:0.75rem;padding:0.75rem;background:#1a3a1a;border-radius:8px;font-size:0.85rem">
      <strong>Recommended: Browser Login (no cookie needed)</strong><br>
      Run in terminal: <code style="background:#333;padding:2px 6px;border-radius:4px">npx ts-node src/cli.ts login --provider suno</code><br>
      A browser opens → log in with Google → session saved automatically.<br>
      Add multiple accounts by running the command again with <code style="background:#333;padding:2px 6px;border-radius:4px">--email your@email.com</code>
    </div>
    <div class="account-form">
      <select id="accProvider" style="flex:0 0 100px"><option value="suno">Suno</option><option value="udio">Udio</option></select>
      <input id="accCookie" placeholder="Or paste session cookie (legacy method)" type="password">
      <button class="btn-secondary" onclick="addAccount()">Add</button>
    </div>
    <div id="providerStatus" style="margin-top:0.5rem;font-size:0.85rem"></div>
  </div>

  <script>
    const $ = (s) => document.querySelector(s);
    let polling = null;

    $('#genForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const body = {
        genre: $('#genre').value,
        count: $('#count').value,
        duration: $('#duration').value,
        mood: $('#mood').value,
      };
      try {
        const r = await fetch('/api/generate', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
        const d = await r.json();
        if (r.ok) {
          $('#startBtn').style.display = 'none';
          $('#stopBtn').style.display = 'inline-block';
          $('#progressArea').style.display = 'block';
          startPolling();
        } else {
          alert(d.error || 'Failed');
        }
      } catch(e) { alert(e); }
    });

    $('#stopBtn').addEventListener('click', async () => {
      await fetch('/api/stop', { method: 'POST' });
      stopPolling();
      $('#startBtn').style.display = 'inline-block';
      $('#stopBtn').style.display = 'none';
    });

    function startPolling() {
      polling = setInterval(pollQueue, 3000);
    }
    function stopPolling() {
      if (polling) clearInterval(polling);
      polling = null;
    }

    async function pollQueue() {
      try {
        const r = await fetch('/api/queue');
        const d = await r.json();
        if (d.stats) {
          const { total, done, failed, pending, running } = d.stats;
          const pct = total > 0 ? Math.round(((done+failed)/total)*100) : 0;
          $('#progressBar').style.width = pct+'%';
          $('#status-text').textContent = pct+'% — '+done+' done, '+failed+' failed, '+running+' running, '+pending+' pending';

          if (pending === 0 && running === 0) {
            stopPolling();
            $('#startBtn').style.display = 'inline-block';
            $('#stopBtn').style.display = 'none';
          }
        }
        if (d.jobs && d.jobs.length > 0) {
          $('#jobList').innerHTML = d.jobs.map(j =>
            '<div class="job"><span>'+j.prompt.substring(0,40)+'</span><span class="status-'+j.status+'">'+j.status+(j.provider?' ('+j.provider+')':'')+'</span></div>'
          ).join('');
        }
      } catch(e) {}
      loadLibrary();
    }

    async function loadLibrary() {
      try {
        const r = await fetch('/api/library');
        const d = await r.json();
        if (d.length === 0) {
          $('#library').innerHTML = '<p style="color:#8b949e;font-size:0.85rem">No tracks yet</p>';
          return;
        }
        let html = '';
        let total = 0;
        for (const g of d) {
          total += g.tracks.length;
          html += '<div style="margin-bottom:0.5rem"><span class="genre-chip">'+g.genre+' ('+g.tracks.length+')</span></div>';
        }
        html = '<p style="margin-bottom:0.5rem;font-size:0.9rem"><strong>'+total+'</strong> total tracks</p>' + html;
        $('#library').innerHTML = html;
      } catch(e) {}
    }

    async function addAccount() {
      const provider = $('#accProvider').value;
      const cookie = $('#accCookie').value;
      if (!cookie) return alert('Enter a cookie');
      try {
        const r = await fetch('/api/accounts', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({provider,cookie}) });
        const d = await r.json();
        if (r.ok) {
          alert('Account added: '+d.account);
          $('#accCookie').value = '';
          loadStatus();
        } else {
          alert(d.error);
        }
      } catch(e) { alert(e); }
    }

    async function loadStatus() {
      try {
        const r = await fetch('/api/status');
        const d = await r.json();
        let html = '';
        html += 'Suno: '+(d.providers.suno.enabled ? '<span class="badge badge-green">ON</span>' : '<span class="badge badge-gray">OFF</span>')+' '+d.providers.suno.accounts+' accounts &nbsp;';
        html += 'Udio: '+(d.providers.udio.enabled ? '<span class="badge badge-green">ON</span>' : '<span class="badge badge-gray">OFF</span>')+' '+d.providers.udio.accounts+' accounts';
        $('#providerStatus').innerHTML = html;
      } catch(e) {}
    }

    loadStatus();
    loadLibrary();
  </script>
</body>
</html>`;

// --- Start server ---
const PORT = parseInt(process.env.PORT || "3456");

export function startServer(): void {
  app.listen(PORT, () => {
    logger.info(`Web UI running at http://localhost:${PORT}`);
    console.log(`\n  Web UI: http://localhost:${PORT}\n`);
  });
}

// If run directly
if (require.main === module) {
  startServer();
}
