/**
 * Deep-link config (technical-doc.md §4, §9): push notifications for approvals /
 * turn-complete route into the Session screen. Scheme `brainrouter://` is
 * declared in app.json. The notification → S-05 approval-sheet route is wired
 * in M1 alongside expo-notifications (`lib/notifications.ts`).
 */
import type { LinkingOptions } from '@react-navigation/native';
import type { RootStackParamList } from './types';

export const linking: LinkingOptions<RootStackParamList> = {
  prefixes: ['brainrouter://'],
  config: {
    screens: {
      Connect: 'connect',
      App: {
        screens: {
          ChatsTab: {
            screens: {
              Chats: 'chats',
              Session: 'session/:sessionKey',
              Changes: 'changes',
            },
          },
          ActivityTab: { screens: { Activity: 'activity' } },
          ReviewTab: { screens: { Review: 'review' } },
          SettingsTab: { screens: { Settings: 'settings' } },
        },
      },
    },
  },
};
