import type { SQLiteDatabase } from 'expo-sqlite';

export type Note = {
  id: number;
  title: string;
  body: string;
  createdAt: number;
  updatedAt: number;
};
export type Theme = 'light' | 'dark';

const migrations: Array<(db: SQLiteDatabase) => Promise<void>> = [
  (db) =>
    db.execAsync(`
      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
    `),
  (db) =>
    db.execAsync(`
      ALTER TABLE notes ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
      UPDATE notes SET updated_at = created_at;
    `),
];

export async function migrate(db: SQLiteDatabase): Promise<void> {
  await db.execAsync('PRAGMA journal_mode = WAL');
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const applied = row?.user_version ?? 0;
  for (const [index, step] of migrations.entries()) {
    if (index < applied) continue;
    await step(db);
    await db.execAsync(`PRAGMA user_version = ${index + 1}`);
  }
}

export function listNotes(db: SQLiteDatabase): Promise<Note[]> {
  return db.getAllAsync<Note>(
    'SELECT id, title, body, created_at AS createdAt, updated_at AS updatedAt FROM notes ORDER BY created_at DESC, id DESC'
  );
}

export async function addNote(db: SQLiteDatabase, title: string, body: string): Promise<void> {
  const now = Date.now();
  await db.runAsync(
    'INSERT INTO notes (title, body, created_at, updated_at) VALUES (?, ?, ?, ?)',
    title,
    body,
    now,
    now
  );
}

export async function updateNote(
  db: SQLiteDatabase,
  id: number,
  title: string,
  body: string
): Promise<void> {
  await db.runAsync(
    'UPDATE notes SET title = ?, body = ?, updated_at = ? WHERE id = ?',
    title,
    body,
    Date.now(),
    id
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
