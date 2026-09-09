import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import initialItems from './src/items.json';
import { totalCents } from './src/total';

export default function App() {
  const [items, setItems] = useState(initialItems);
  return <View style={{ padding: 32 }}>
    <Text accessibilityRole="header">Coffee cart</Text>
    {items.map(item => <View key={item.id}>
      <Text>{item.name}: {item.quantity}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`Add ${item.name}`}
        onPress={() => setItems(items.map(i => i.id === item.id ? { ...i, quantity: i.quantity + 1 } : i))}>
        <Text>Add {item.name}</Text>
      </Pressable>
    </View>)}
    <Text testID="cart-total">${(totalCents(items) / 100).toFixed(2)}</Text>
  </View>;
}
