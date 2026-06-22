/**
 * AppTabs — the main bottom-tab navigator (Chats · Activity · Review · Settings),
 * each tab owning a native stack (technical-doc.md §4). Tab styling comes from
 * the design tokens.
 */
import React from 'react';
import { Text } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useTheme } from '../theme/ThemeProvider';
import { ChatsScreen } from '../screens/ChatsScreen';
import { SessionScreen } from '../screens/SessionScreen';
import { ChangesScreen } from '../screens/ChangesScreen';
import { ActivityScreen } from '../screens/ActivityScreen';
import { ReviewScreen } from '../screens/ReviewScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import type {
  AppTabsParamList,
  ChatsStackParamList,
  ActivityStackParamList,
  ReviewStackParamList,
  SettingsStackParamList,
} from './types';

const Tabs = createBottomTabNavigator<AppTabsParamList>();
const ChatsStack = createNativeStackNavigator<ChatsStackParamList>();
const ActivityStack = createNativeStackNavigator<ActivityStackParamList>();
const ReviewStack = createNativeStackNavigator<ReviewStackParamList>();
const SettingsStack = createNativeStackNavigator<SettingsStackParamList>();

function ChatsNavigator(): React.JSX.Element {
  return (
    <ChatsStack.Navigator screenOptions={{ headerShown: false }}>
      <ChatsStack.Screen name="Chats" component={ChatsScreen} />
      <ChatsStack.Screen name="Session" component={SessionScreen} options={{ headerShown: true, title: 'Session' }} />
      <ChatsStack.Screen name="Changes" component={ChangesScreen} options={{ headerShown: true, title: 'Changes' }} />
    </ChatsStack.Navigator>
  );
}

function ActivityNavigator(): React.JSX.Element {
  return (
    <ActivityStack.Navigator screenOptions={{ headerShown: false }}>
      <ActivityStack.Screen name="Activity" component={ActivityScreen} />
    </ActivityStack.Navigator>
  );
}

function ReviewNavigator(): React.JSX.Element {
  return (
    <ReviewStack.Navigator screenOptions={{ headerShown: false }}>
      <ReviewStack.Screen name="Review" component={ReviewScreen} />
    </ReviewStack.Navigator>
  );
}

function SettingsNavigator(): React.JSX.Element {
  return (
    <SettingsStack.Navigator screenOptions={{ headerShown: false }}>
      <SettingsStack.Screen name="Settings" component={SettingsScreen} />
    </SettingsStack.Navigator>
  );
}

const TAB_GLYPH: Record<keyof AppTabsParamList, string> = {
  ChatsTab: '💬',
  ActivityTab: '📊',
  ReviewTab: '✓',
  SettingsTab: '⚙',
};

export function AppTabs(): React.JSX.Element {
  const theme = useTheme();
  return (
    <Tabs.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: theme.colors.accent,
        tabBarInactiveTintColor: theme.colors.muted,
        tabBarStyle: { backgroundColor: theme.colors.raised, borderTopColor: theme.colors.border },
        tabBarIcon: ({ color }) => (
          <Text style={{ color, fontSize: 16 }}>{TAB_GLYPH[route.name]}</Text>
        ),
      })}
    >
      <Tabs.Screen name="ChatsTab" component={ChatsNavigator} options={{ title: 'Chats' }} />
      <Tabs.Screen name="ActivityTab" component={ActivityNavigator} options={{ title: 'Activity' }} />
      <Tabs.Screen name="ReviewTab" component={ReviewNavigator} options={{ title: 'Review' }} />
      <Tabs.Screen name="SettingsTab" component={SettingsNavigator} options={{ title: 'Settings' }} />
    </Tabs.Navigator>
  );
}
