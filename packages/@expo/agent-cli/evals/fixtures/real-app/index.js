import { registerRootComponent } from 'expo';
import React from 'react';
import { Text } from 'react-native';
function App() { return React.createElement(Text, null, 'Real Expo fixture'); }
registerRootComponent(App);
