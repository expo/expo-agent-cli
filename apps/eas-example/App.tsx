import { StatusBar } from 'expo-status-bar';
import { SQLiteProvider, useSQLiteContext } from 'expo-sqlite';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { addNote, deleteNote, listNotes, migrate, readTheme, writeTheme } from './notesDb';
import type { Note, Theme } from './notesDb';

// A stable string the live-eas deploy test looks for in the served web bundle.
const DEPLOY_MARKER = '@expo/agent-cli live-eas deploy marker';

type Screen = { kind: 'list' } | { kind: 'new' } | { kind: 'detail'; note: Note };

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
  const [theme, setTheme] = useState<Theme>('light');
  const p = palettes[theme];

  const refresh = useCallback(async () => setNotes(await listNotes(db)), [db]);

  useEffect(() => {
    refresh();
    readTheme(db).then(setTheme);
  }, [db, refresh]);

  const toggleTheme = async () => {
    const next: Theme = theme === 'light' ? 'dark' : 'light';
    await writeTheme(db, next);
    setTheme(next);
  };

  return (
    <SafeAreaView style={[styles.root, { backgroundColor: p.bg }]}>
      <View style={styles.header}>
        <Text testID="notes-title" style={[styles.title, { color: p.fg }]}>
          Notes ({notes.length})
        </Text>
        <Pressable testID="theme-toggle" onPress={toggleTheme} style={styles.button}>
          <Text style={{ color: p.accent }}>{theme === 'light' ? 'Dark' : 'Light'}</Text>
        </Pressable>
      </View>
      {screen.kind === 'list' && (
        <NoteList
          notes={notes}
          p={p}
          onNew={() => setScreen({ kind: 'new' })}
          onOpen={(note) => setScreen({ kind: 'detail', note })}
        />
      )}
      {screen.kind === 'new' && (
        <NewNote
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
          onDelete={async () => {
            await deleteNote(db, screen.note.id);
            await refresh();
            setScreen({ kind: 'list' });
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
  p: Palette;
  onNew: () => void;
  onOpen: (note: Note) => void;
}) {
  const { notes, p } = props;
  return (
    <View style={styles.body}>
      <Pressable testID="new-note" onPress={props.onNew} style={styles.button}>
        <Text style={{ color: p.accent }}>New note</Text>
      </Pressable>
      {notes.length === 0 ? (
        <Text testID="empty-state" style={[styles.empty, { color: p.muted }]}>
          No notes yet. Tap New note to write one.
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

function NewNote(props: {
  p: Palette;
  onBack: () => void;
  onSave: (title: string, body: string) => Promise<void>;
}) {
  const { p } = props;
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
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

function NoteDetail(props: { note: Note; p: Palette; onBack: () => void; onDelete: () => void }) {
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
      <Text testID="detail-body" style={{ color: p.fg }}>
        {note.body}
      </Text>
      <Pressable testID="delete-note" onPress={props.onDelete} style={styles.button}>
        <Text style={{ color: '#d33' }}>Delete</Text>
      </Pressable>
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
  disabled: { opacity: 0.4 },
  empty: { marginTop: 32, textAlign: 'center' },
  card: { padding: 12, borderRadius: 8, marginBottom: 8 },
  noteTitle: { fontSize: 18, fontWeight: '600' },
  date: { fontSize: 12 },
  input: { padding: 10, borderRadius: 8 },
  bodyInput: { minHeight: 120, textAlignVertical: 'top' },
  marker: { textAlign: 'center', fontSize: 12, padding: 8 },
});
