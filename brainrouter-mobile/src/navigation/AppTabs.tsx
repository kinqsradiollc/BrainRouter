/**
 * AppTabs — the main bottom-tab navigator (Chats · Activity · Review · More ·
 * Settings), each tab owning a native stack (technical-doc.md §4). The More tab
 * hubs the secondary record surfaces (requirements/annotations/artifacts/
 * schedules). Tab + header styling come from the design tokens; tab icons use the
 * DESK-4k set (the prototype's icons), not emoji.
 */
import React from 'react';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useTheme } from '../theme/ThemeProvider';
import { Icon, type IconName } from '../components/Icon';
import { ProjectsScreen } from '../screens/ProjectsScreen';
import { ChatsScreen } from '../screens/ChatsScreen';
import { SessionScreen } from '../screens/SessionScreen';
import { ChangesScreen } from '../screens/ChangesScreen';
import { ActivityScreen } from '../screens/ActivityScreen';
import { ReviewScreen } from '../screens/ReviewScreen';
import { SettingsScreen } from '../screens/SettingsScreen';
import { MoreScreen } from '../screens/MoreScreen';
import { RequirementsScreen } from '../screens/RequirementsScreen';
import { AnnotationsScreen } from '../screens/AnnotationsScreen';
import { ArtifactsScreen } from '../screens/ArtifactsScreen';
import { SchedulesScreen } from '../screens/SchedulesScreen';
import { CIScreen } from '../screens/CIScreen';
import { WorktreesScreen } from '../screens/WorktreesScreen';
import { SearchScreen } from '../screens/SearchScreen';
import { FilesScreen } from '../screens/FilesScreen';
import { FileViewerScreen } from '../screens/FileViewerScreen';
import { TrackScreen } from '../screens/TrackScreen';
import { TerminalScreen } from '../screens/TerminalScreen';
import { EditorScreen } from '../screens/EditorScreen';
import { MemoryScreen } from '../screens/MemoryScreen';
import type {
  AppTabsParamList,
  ChatsStackParamList,
  ActivityStackParamList,
  ReviewStackParamList,
  SettingsStackParamList,
  MoreStackParamList,
} from './types';

const Tabs = createBottomTabNavigator<AppTabsParamList>();
const ChatsStack = createNativeStackNavigator<ChatsStackParamList>();
const ActivityStack = createNativeStackNavigator<ActivityStackParamList>();
const ReviewStack = createNativeStackNavigator<ReviewStackParamList>();
const SettingsStack = createNativeStackNavigator<SettingsStackParamList>();
const MoreStack = createNativeStackNavigator<MoreStackParamList>();

/** Themed native-header options for pushed screens (back button + title). */
function useStackHeader() {
  const theme = useTheme();
  return {
    headerShown: true,
    headerStyle: { backgroundColor: theme.colors.raised },
    headerTintColor: theme.colors.text,
    headerTitleStyle: { color: theme.colors.text },
    headerShadowVisible: false,
  };
}

function ChatsNavigator(): React.JSX.Element {
  const header = useStackHeader();
  return (
    <ChatsStack.Navigator screenOptions={{ headerShown: false }}>
      <ChatsStack.Screen name="Projects" component={ProjectsScreen} />
      <ChatsStack.Screen name="Chats" component={ChatsScreen} />
      <ChatsStack.Screen name="Session" component={SessionScreen} options={{ headerShown: false }} />
      <ChatsStack.Screen name="Changes" component={ChangesScreen} options={{ ...header, title: 'Changes' }} />
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

function MoreNavigator(): React.JSX.Element {
  const header = useStackHeader();
  return (
    <MoreStack.Navigator screenOptions={{ headerShown: false }}>
      <MoreStack.Screen name="More" component={MoreScreen} />
      <MoreStack.Screen name="Memory" component={MemoryScreen} options={{ ...header, title: 'Memory' }} />
      <MoreStack.Screen name="Requirements" component={RequirementsScreen} options={{ ...header, title: 'Requirements' }} />
      <MoreStack.Screen name="Annotations" component={AnnotationsScreen} options={{ ...header, title: 'Annotations' }} />
      <MoreStack.Screen name="Artifacts" component={ArtifactsScreen} options={{ ...header, title: 'Artifacts' }} />
      <MoreStack.Screen name="Schedules" component={SchedulesScreen} options={{ ...header, title: 'Schedules' }} />
      <MoreStack.Screen name="CI" component={CIScreen} options={{ ...header, title: 'CI checks' }} />
      <MoreStack.Screen name="Worktrees" component={WorktreesScreen} options={{ ...header, title: 'Worktrees' }} />
      <MoreStack.Screen name="Search" component={SearchScreen} options={{ ...header, title: 'Search' }} />
      <MoreStack.Screen name="Files" component={FilesScreen} options={{ ...header, title: 'Files' }} />
      <MoreStack.Screen name="FileViewer" component={FileViewerScreen} options={{ ...header, title: 'File' }} />
      <MoreStack.Screen name="Editor" component={EditorScreen} options={{ ...header, title: 'Editor' }} />
      <MoreStack.Screen name="Terminal" component={TerminalScreen} options={{ ...header, title: 'Terminal' }} />
      <MoreStack.Screen name="Track" component={TrackScreen} options={{ ...header, title: 'Track' }} />
    </MoreStack.Navigator>
  );
}

const TAB_ICON: Record<keyof AppTabsParamList, IconName> = {
  ChatsTab: 'bubble',
  ActivityTab: 'monitor',
  ReviewTab: 'review',
  MoreTab: 'panels',
  SettingsTab: 'gear',
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
        tabBarIcon: ({ color, size }) => <Icon name={TAB_ICON[route.name]} size={size ?? 22} color={color} />,
      })}
    >
      <Tabs.Screen name="ChatsTab" component={ChatsNavigator} options={{ title: 'Projects' }} />
      <Tabs.Screen name="ActivityTab" component={ActivityNavigator} options={{ title: 'Activity' }} />
      <Tabs.Screen name="ReviewTab" component={ReviewNavigator} options={{ title: 'Review' }} />
      <Tabs.Screen name="MoreTab" component={MoreNavigator} options={{ title: 'More' }} />
      <Tabs.Screen name="SettingsTab" component={SettingsNavigator} options={{ title: 'Settings' }} />
    </Tabs.Navigator>
  );
}
