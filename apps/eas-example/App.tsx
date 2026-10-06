import { StatusBar } from 'expo-status-bar';
import { SQLiteProvider, useSQLiteContext } from 'expo-sqlite';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import {
  addNote,
  countNotes,
  deleteNote,
  listNotes,
  migrate,
  readTheme,
  setPinned,
  updateNote,
  writeTheme,
} from './notesDb';
import type { Note, Theme } from './notesDb';

// A stable string the live-eas deploy test looks for in the served web bundle.
const DEPLOY_MARKER = '@expo/agent-cli live-eas deploy marker';

type Screen =
  | { kind: 'list' }
  | { kind: 'new' }
  | { kind: 'detail'; note: Note }
  | { kind: 'edit'; note: Note };

const palettes = {
  light: { bg: '#fff', fg: '#111', muted: '#666', card: '#f2f2f2', accent: '#0a7ea4' },
  dark: { bg: '#111', fg: '#eee', muted: '#999', card: '#222', accent: '#4cc2ff' },
} as const;
type Palette = (typeof palettes)[Theme];

export default function App() {
  return (
    <SafeAreaProvider>
      <SQLiteProvider databaseName="notes.db" onInit={migrate}>
        <NotesApp />
      </SQLiteProvider>
    </SafeAreaProvider>
  );
}

function NotesApp() {
  const db = useSQLiteContext();
  const [screen, setScreen] = useState<Screen>({ kind: 'list' });
  const [notes, setNotes] = useState<Note[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState('');
  const [theme, setTheme] = useState<Theme>('light');
  const p = palettes[theme];

  const refresh = useCallback(async () => {
    const next = await listNotes(db, query);
    setNotes(next);
    setTotal(await countNotes(db));
    return next;
  }, [db, query]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    readTheme(db).then(setTheme);
  }, [db]);

  const toggleTheme = async () => {
    const next: Theme = theme === 'light' ? 'dark' : 'light';
    await writeTheme(db, next);
    setTheme(next);
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: p.bg }]}>
      <View style={styles.header}>
        <Text testID="notes-title" style={[styles.title, { color: p.fg }]}>
          Notes ({total})
        </Text>
        <Pressable testID="theme-toggle" onPress={toggleTheme} style={styles.button}>
          <Text style={{ color: p.accent }}>{theme === 'light' ? 'Dark' : 'Light'}</Text>
        </Pressable>
      </View>
      {screen.kind === 'list' && (
        <NoteList
          notes={notes}
          total={total}
          query={query}
          onQuery={setQuery}
          p={p}
          onNew={() => setScreen({ kind: 'new' })}
          onOpen={(note) => setScreen({ kind: 'detail', note })}
        />
      )}
      {screen.kind === 'new' && (
        <NoteForm
          p={p}
          onBack={() => setScreen({ kind: 'list' })}
          onSave={async (title, body) => {
            await addNote(db, title, body);
            await refresh();
            setScreen({ kind: 'list' });
          }}
        />
      )}
      {screen.kind === 'detail' && (
        <NoteDetail
          note={screen.note}
          p={p}
          onBack={() => setScreen({ kind: 'list' })}
          onEdit={() => setScreen({ kind: 'edit', note: screen.note })}
          onTogglePin={async () => {
            await setPinned(db, screen.note.id, !screen.note.pinned);
            const next = await refresh();
            const note = next.find((n) => n.id === screen.note.id);
            setScreen(note ? { kind: 'detail', note } : { kind: 'list' });
          }}
          onDelete={async () => {
            await deleteNote(db, screen.note.id);
            await refresh();
            setScreen({ kind: 'list' });
          }}
        />
      )}
      {screen.kind === 'edit' && (
        <NoteForm
          p={p}
          initialTitle={screen.note.title}
          initialBody={screen.note.body}
          onBack={() => setScreen({ kind: 'detail', note: screen.note })}
          onSave={async (title, body) => {
            await updateNote(db, screen.note.id, title, body);
            const next = await refresh();
            const note = next.find((n) => n.id === screen.note.id);
            setScreen(note ? { kind: 'detail', note } : { kind: 'list' });
          }}
        />
      )}
      <Text testID="deploy-marker" style={[styles.marker, { color: p.muted }]}>
        {DEPLOY_MARKER}
      </Text>
      <StatusBar style={theme === 'light' ? 'dark' : 'light'} />
    </SafeAreaView>
  );
}

function NoteList(props: {
  notes: Note[];
  total: number;
  query: string;
  onQuery: (query: string) => void;
  p: Palette;
  onNew: () => void;
  onOpen: (note: Note) => void;
}) {
  const { notes, p } = props;
  return (
    <View style={styles.body}>
      <TextInput
        testID="search-input"
        placeholder="Search"
        placeholderTextColor={p.muted}
        value={props.query}
        onChangeText={props.onQuery}
        autoCapitalize="none"
        autoCorrect={false}
        style={[styles.input, { color: p.fg, backgroundColor: p.card }]}
      />
      <Pressable testID="new-note" onPress={props.onNew} style={styles.button}>
        <Text style={{ color: p.accent }}>New note</Text>
      </Pressable>
      {props.total === 0 ? (
        <Text testID="empty-state" style={[styles.empty, { color: p.muted }]}>
          No notes yet. Tap New note to write one.
        </Text>
      ) : notes.length === 0 ? (
        <Text testID="no-matches" style={[styles.empty, { color: p.muted }]}>
          No notes match.
        </Text>
      ) : (
        <FlatList
          data={notes}
          keyExtractor={(n) => String(n.id)}
          renderItem={({ item }) => (
            <Pressable
              testID={`note-${item.id}`}
              onPress={() => props.onOpen(item)}
              style={[styles.card, { backgroundColor: p.card }]}
            >
              {item.pinned && (
                <Text testID={`pinned-${item.id}`} style={[styles.date, { color: p.accent }]}>
                  Pinned
                </Text>
              )}
              <Text style={[styles.noteTitle, { color: p.fg }]}>{item.title || 'Untitled'}</Text>
              <Text numberOfLines={1} style={{ color: p.muted }}>
                {item.body.split('\n')[0]}
              </Text>
              <Text style={[styles.date, { color: p.muted }]}>
                {new Date(item.createdAt).toLocaleString()}
              </Text>
            </Pressable>
          )}
        />
      )}
    </View>
  );
}

function NoteForm(props: {
  p: Palette;
  initialTitle?: string;
  initialBody?: string;
  onBack: () => void;
  onSave: (title: string, body: string) => Promise<void>;
}) {
  const { p } = props;
  const [title, setTitle] = useState(props.initialTitle ?? '');
  const [body, setBody] = useState(props.initialBody ?? '');
  const canSave = title.trim() !== '' || body.trim() !== '';
  const inputStyle = [styles.input, { color: p.fg, backgroundColor: p.card }];
  return (
    <View style={styles.body}>
      <Pressable testID="back" onPress={props.onBack} style={styles.button}>
        <Text style={{ color: p.accent }}>Back</Text>
      </Pressable>
      <TextInput
        testID="note-title-input"
        placeholder="Title"
        placeholderTextColor={p.muted}
        value={title}
        onChangeText={setTitle}
        style={inputStyle}
      />
      <TextInput
        testID="note-body-input"
        placeholder="Body"
        placeholderTextColor={p.muted}
        value={body}
        onChangeText={setBody}
        multiline
        style={[inputStyle, styles.bodyInput]}
      />
      <Pressable
        testID="save-note"
        disabled={!canSave}
        onPress={() => props.onSave(title.trim(), body)}
        style={[styles.button, !canSave && styles.disabled]}
      >
        <Text style={{ color: p.accent }}>Save</Text>
      </Pressable>
    </View>
  );
}

function NoteDetail(props: {
  note: Note;
  p: Palette;
  onBack: () => void;
  onEdit: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
}) {
  const { note, p } = props;
  return (
    <View style={styles.body}>
      <Pressable testID="back" onPress={props.onBack} style={styles.button}>
        <Text style={{ color: p.accent }}>Back</Text>
      </Pressable>
      <Text testID="detail-title" style={[styles.noteTitle, { color: p.fg }]}>
        {note.title || 'Untitled'}
      </Text>
      <Text style={[styles.date, { color: p.muted }]}>
        {new Date(note.createdAt).toLocaleString()}
      </Text>
      {note.updatedAt !== note.createdAt && (
        <Text testID="detail-edited" style={[styles.date, { color: p.muted }]}>
          Edited {new Date(note.updatedAt).toLocaleString()}
        </Text>
      )}
      <Text testID="detail-body" style={{ color: p.fg }}>
        {note.body}
      </Text>
      <View style={styles.actions}>
        <Pressable testID="edit-note" onPress={props.onEdit} style={styles.button}>
          <Text style={{ color: p.accent }}>Edit</Text>
        </Pressable>
        <Pressable testID="pin-note" onPress={props.onTogglePin} style={styles.button}>
          <Text style={{ color: p.accent }}>{note.pinned ? 'Unpin' : 'Pin'}</Text>
        </Pressable>
        <Pressable testID="delete-note" onPress={props.onDelete} style={styles.button}>
          <Text style={{ color: '#d33' }}>Delete</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
  },
  title: { fontSize: 24, fontWeight: '600' },
  body: { flex: 1, paddingHorizontal: 16, gap: 8 },
  button: { paddingVertical: 8, alignSelf: 'flex-start' },
  actions: { flexDirection: 'row', gap: 16 },
  disabled: { opacity: 0.4 },
  empty: { marginTop: 32, textAlign: 'center' },
  card: { padding: 12, borderRadius: 8, marginBottom: 8 },
  noteTitle: { fontSize: 18, fontWeight: '600' },
  date: { fontSize: 12 },
  input: { padding: 10, borderRadius: 8 },
  bodyInput: { minHeight: 120, textAlignVertical: 'top' },
  marker: { textAlign: 'center', fontSize: 12, padding: 8 },
});
