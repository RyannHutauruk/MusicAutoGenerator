import sanitize from "sanitize-filename";
import path from "path";
import fs from "fs";

const LIBRARY_DIR = path.resolve(process.cwd(), "music-library");

/** Create a safe folder name from a genre/topic string. */
export function genreToFolder(genre: string): string {
  return sanitize(genre.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, ""));
}

/** Ensure genre folder exists and return path. */
export function ensureGenreFolder(genre: string): string {
  const folder = path.join(LIBRARY_DIR, genreToFolder(genre));
  fs.mkdirSync(folder, { recursive: true });
  return folder;
}

/** Get the next track number for a genre folder. */
export function getNextTrackNumber(genreFolder: string, prefix: string = "track"): string {
  if (!fs.existsSync(genreFolder)) return `${prefix}001`;
  const existing = fs.readdirSync(genreFolder).filter((f) => f.endsWith(".mp3"));
  const numbers = existing
    .map((f) => {
      const match = f.match(/(\d+)\.mp3$/);
      return match ? parseInt(match[1], 10) : 0;
    })
    .filter((n) => n > 0);
  const next = numbers.length > 0 ? Math.max(...numbers) + 1 : 1;
  return `${prefix}${String(next).padStart(3, "0")}`;
}

/** Generate a track filename. */
export function generateTrackFilename(genre: string, index?: number): string {
  const folder = ensureGenreFolder(genre);
  const prefix = genreToFolder(genre).substring(0, 10);
  const trackNum = index
    ? `${prefix}${String(index).padStart(3, "0")}`
    : getNextTrackNumber(folder, prefix);
  return `${trackNum}.mp3`;
}

/** Check if a file already exists (duplicate detection). */
export function isDuplicate(genreFolder: string, filename: string): boolean {
  return fs.existsSync(path.join(genreFolder, filename));
}

/** Save metadata JSON alongside a track. */
export function saveMetadata(
  trackPath: string,
  metadata: {
    prompt: string;
    provider: string;
    createdAt: string;
    duration: number;
    genre: string;
  }
): void {
  const metaPath = trackPath.replace(/\.mp3$/, ".json");
  fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
}

/** Random delay to mimic human behavior. */
export function randomDelay(minMs: number = 1000, maxMs: number = 3000): Promise<void> {
  const delay = Math.floor(Math.random() * (maxMs - minMs) + minMs);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/** Get list of all genre folders. */
export function listGenres(): string[] {
  if (!fs.existsSync(LIBRARY_DIR)) return [];
  return fs
    .readdirSync(LIBRARY_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

/** Count tracks in a genre folder. */
export function countTracks(genre: string): number {
  const folder = path.join(LIBRARY_DIR, genreToFolder(genre));
  if (!fs.existsSync(folder)) return 0;
  return fs.readdirSync(folder).filter((f) => f.endsWith(".mp3")).length;
}
