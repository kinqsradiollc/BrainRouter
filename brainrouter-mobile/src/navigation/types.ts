/**
 * Navigation param lists (React Navigation v7). The app is a root native-stack
 * with a Connect screen (S-01) and the main bottom-tabs; each tab owns a native
 * stack. Screen ids map to ui-spec.md S-xx.
 */
import type { NavigatorScreenParams } from '@react-navigation/native';

export type ChatsStackParamList = {
  Projects: undefined; // S-02 — projects (workspaces)
  Chats: { projectRoot?: string; projectName?: string }; // S-02 — a project's chat sessions
  Session: { sessionKey: string }; // S-03
  Changes: { sessionKey?: string }; // S-07
};

export type ActivityStackParamList = {
  Activity: undefined; // S-10
};

export type ReviewStackParamList = {
  Review: undefined; // S-11 / S-12
};

export type SettingsStackParamList = {
  Settings: undefined; // S-14
};

export type MoreStackParamList = {
  More: undefined; // hub
  Memory: undefined; // S-34
  Connectors: undefined; // S-35
  Requirements: undefined; // S-26
  Annotations: undefined; // S-27
  Artifacts: undefined; // S-28
  Schedules: undefined; // S-29
  CI: undefined; // S-25
  Worktrees: undefined; // S-30
  Search: undefined; // S-22
  Files: undefined; // S-20
  FileViewer: { path: string }; // S-21
  Track: undefined; // S-31
  Terminal: undefined; // S-33
  Editor: undefined; // S-32
};

export type AppTabsParamList = {
  ChatsTab: NavigatorScreenParams<ChatsStackParamList>;
  ActivityTab: NavigatorScreenParams<ActivityStackParamList>;
  ReviewTab: NavigatorScreenParams<ReviewStackParamList>;
  MoreTab: NavigatorScreenParams<MoreStackParamList>;
  SettingsTab: NavigatorScreenParams<SettingsStackParamList>;
};

export type RootStackParamList = {
  Connect: undefined; // S-01
  App: NavigatorScreenParams<AppTabsParamList>;
};
