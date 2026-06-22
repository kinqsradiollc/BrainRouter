/**
 * RootNavigator — the root native-stack: Connect (S-01) | App (the bottom tabs).
 * In M0 the app boots straight into the tabs against the MockTransport; M1 gates
 * this on the connection/pairing state (connectionStore).
 */
import React from 'react';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { ConnectScreen } from '../screens/ConnectScreen';
import { AppTabs } from './AppTabs';
import type { RootStackParamList } from './types';

const Root = createNativeStackNavigator<RootStackParamList>();

export function RootNavigator(): React.JSX.Element {
  return (
    <Root.Navigator initialRouteName="App" screenOptions={{ headerShown: false }}>
      <Root.Screen name="App" component={AppTabs} />
      <Root.Screen name="Connect" component={ConnectScreen} options={{ presentation: 'modal', headerShown: true, title: 'Connect' }} />
    </Root.Navigator>
  );
}
