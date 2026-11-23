import { Link } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

// A stable string the live-eas deploy test looks for in the served web bundle.
const DEPLOY_MARKER = '@expo/agent-cli live-eas deploy marker';

export default function HomeScreen() {
  const [count, setCount] = useState(0);
  return (
    <View style={styles.container}>
      <Text testID="home-title">EAS Example home</Text>
      <Text>{DEPLOY_MARKER}</Text>
      <Pressable testID="counter-button" onPress={() => setCount((value) => value + 1)}>
        <Text testID="counter-value">Count: {count}</Text>
      </Pressable>
      <Link href="/explore" testID="explore-link">
        Open explore
      </Link>
      <StatusBar style="auto" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    gap: 16,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
