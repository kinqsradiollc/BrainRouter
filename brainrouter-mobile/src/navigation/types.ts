/**
 * Navigation param lists (React Navigation v7). The app is a root native-stack
 * with a Connect screen (S-01) and the main bottom-tabs; each tab owns a native
 * stack. Screen ids map to ui-spec.md S-xx.
 */
import type { NavigatorScreenParams } from '@react-navigation/native';

export type ChatsStackParamList = {
  Chats: undefined; // S-02
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

export type AppTabsParamList = {
  ChatsTab: NavigatorScreenParams<ChatsStackParamList>;
  ActivityTab: NavigatorScreenParams<ActivityStackParamList>;
  ReviewTab: NavigatorScreenParams<ReviewStackParamList>;
  SettingsTab: NavigatorScreenParams<SettingsStackParamList>;
};

export type RootStackParamList = {
  Connect: undefined; // S-01
  App: NavigatorScreenParams<AppTabsParamList>;
};
