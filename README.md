# Music Generator

AI music generation automation tool — generates tracks from text prompts via Suno/Udio and organizes them into genre folders for YouTube streaming.

## Quick Start

```bash
npm install
npx playwright install chromium

# Interactive mode
npx ts-node src/cli.ts interactive

# Or start the web UI
npx ts-node src/web/server.ts
# → http://localhost:3456
```

## Setup

### 1. Add a Suno Account

Get your cookie from [suno.com](https://suno.com):
- Log in → F12 → Application → Cookies → copy `__client` value

```bash
# Via CLI
npx ts-node src/cli.ts add-account --provider suno --cookie "your_cookie_here"

# Or via web UI: open http://localhost:3456 and paste in the Add Account section
```

### 2. Generate Music

**CLI:**
```bash
# Interactive prompt
npx ts-node src/cli.ts interactive

# Direct command
npx ts-node src/cli.ts generate --genre "lofi hip hop" --count 10 --mood chill

# Continuous mode (generates until stopped or target reached)
npx ts-node src/cli.ts generate --genre "ambient" --count 50 --continuous
```

**Web UI:**
```bash
npx ts-node src/web/server.ts
# Open http://localhost:3456
# Enter genre, count, click "Start Generation"
```

## Output Structure

```
music-library/
  lofi-hip-hop/
    lofi-hip-h001.mp3
    lofi-hip-h001.json    # metadata
    lofi-hip-h002.mp3
  slow-blues/
    slow-blues001.mp3
  ambient/
    ambient001.mp3
```

The folders are automatically consumed by the YouTube streaming system.

## Providers

| Provider | Method | Free Tier |
|----------|--------|-----------|
| Suno (API) | Direct HTTP API via Clerk auth | ~50 credits/day (~10 songs) |
| Suno (Browser) | Playwright automation | Same |
| Udio | Playwright automation | ~10 songs/day |

Providers are modular — add new ones in `src/providers/`.

## Multi-Account Support

Add multiple accounts for automatic rotation:

```bash
npx ts-node src/cli.ts add-account --provider suno --cookie "cookie1" --id account1
npx ts-node src/cli.ts add-account --provider suno --cookie "cookie2" --id account2
```

The system automatically:
- Rotates between accounts
- Tracks daily usage per account
- Applies cooldowns on errors
- Retries failed jobs with different accounts

## Configuration

Edit `config.json`:

```json
{
  "providers": {
    "suno": { "enabled": true, "useApi": true, "accounts": [] },
    "udio": { "enabled": false, "accounts": [] }
  },
  "generation": {
    "maxRetries": 3,
    "delayBetweenJobs": 5000,
    "defaultDuration": 120,
    "instrumental": true
  }
}
```

## Commands

| Command | Description |
|---------|-------------|
| `interactive` / `i` | Interactive prompt mode |
| `generate` / `gen` | Generate tracks (CLI flags) |
| `add-account` | Add a provider account |
| `status` | Show library & provider status |
| `library` | List all tracks |

## Project Structure

```
src/
  providers/         # Music provider adapters
    provider-interface.ts
    suno.ts          # Suno browser automation
    suno-api.ts      # Suno direct API
    udio.ts          # Udio browser automation
  automation/        # Orchestrator
  queue/             # Job queue with retry
  storage/           # Config & account storage
  utils/             # Logger, file helpers
  web/               # Express web UI
  cli.ts             # CLI interface
music-library/       # Generated tracks (git-ignored)
logs/                # Application logs
sessions/            # Browser session data
```
