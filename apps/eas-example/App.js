import { StatusBar } from 'expo-status-bar';
import { StyleSheet, Text, View } from 'react-native';

// A stable string the live-eas deploy test looks for in the served web bundle.
const DEPLOY_MARKER = '@expo/agent-cli live-eas deploy marker';

export default function App() {
  return (
    <View style={styles.container}>
      <Text>{DEPLOY_MARKER}</Text>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
});
