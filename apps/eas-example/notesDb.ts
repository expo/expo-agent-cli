import type { SQLiteDatabase } from 'expo-sqlite';

export type Note = { id: number; title: string; body: string; createdAt: number };
export type Theme = 'light' | 'dark';

const SCHEMA_VERSION = 1;

export async function migrate(db: SQLiteDatabase): Promise<void> {
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((row?.user_version ?? 0) >= SCHEMA_VERSION) return;
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
    PRAGMA user_version = ${SCHEMA_VERSION};
  `);
}

export function listNotes(db: SQLiteDatabase): Promise<Note[]> {
  return db.getAllAsync<Note>(
    'SELECT id, title, body, created_at AS createdAt FROM notes ORDER BY created_at DESC, id DESC'
  );
}

export async function addNote(db: SQLiteDatabase, title: string, body: string): Promise<void> {
  await db.runAsync(
    'INSERT INTO notes (title, body, created_at) VALUES (?, ?, ?)',
    title,
    body,
    Date.now()
  );
}

export async function deleteNote(db: SQLiteDatabase, id: number): Promise<void> {
  await db.runAsync('DELETE FROM notes WHERE id = ?', id);
}

export async function readTheme(db: SQLiteDatabase): Promise<Theme> {
  const row = await db.getFirstAsync<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'theme'"
  );
  return row?.value === 'dark' ? 'dark' : 'light';
}

export async function writeTheme(db: SQLiteDatabase, theme: Theme): Promise<void> {
  await db.runAsync(
    "INSERT INTO settings (key, value) VALUES ('theme', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    theme
  );
}
