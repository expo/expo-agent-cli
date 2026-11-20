import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { StyleSheet, Switch, Text, View } from 'react-native';

// A stable string the live-eas deploy test looks for in the served web bundle.
const DEPLOY_MARKER = '@expo/agent-cli live-eas deploy marker';

export default function App() {
  const [reminders, setReminders] = useState(false);
  return (
    <View style={styles.container}>
      <Text testID="deploy-marker">{DEPLOY_MARKER}</Text>
      <Switch testID="reminders-switch" value={reminders} onValueChange={setReminders} />
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
});
