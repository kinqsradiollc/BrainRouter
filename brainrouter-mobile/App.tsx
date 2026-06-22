/**
 * App root — wires the M0 foundations together (technical-doc.md §4, §5):
 *   GestureHandlerRoot → SafeAreaProvider → ThemeProvider → TransportProvider
 *   → QueryClientProvider → NavigationContainer → RootNavigator.
 *
 * M0 injects a MockTransport so the app boots, themed, with the navigation
 * shell and no live host. M1 swaps in the RemoteTransport (WebSocket) once
 * pairing + the brainrouter-host server exist.
 */
import React, { useMemo } from 'react';
import { StatusBar } from 'expo-status-bar';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  NavigationContainer,
  DefaultTheme as NavLight,
  DarkTheme as NavDark,
  type Theme as NavTheme,
} from '@react-navigation/native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider, useTheme } from './src/theme/ThemeProvider';
import { TransportProvider } from './src/state/TransportProvider';
import { RootNavigator } from './src/navigation/RootNavigator';
import { linking } from './src/navigation/linking';
import { MockTransport } from './src/transport/MockTransport';

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
});

/** Maps the design tokens onto a React Navigation theme. */
function NavigatedApp(): React.JSX.Element {
  const theme = useTheme();
  const navTheme = useMemo<NavTheme>(() => {
    const base = theme.name === 'dark' ? NavDark : NavLight;
    return {
      ...base,
      colors: {
        ...base.colors,
        primary: theme.colors.accent,
        background: theme.colors.base,
        card: theme.colors.raised,
        text: theme.colors.text,
        border: theme.colors.border,
        notification: theme.colors.danger,
      },
    };
  }, [theme]);

  return (
    <NavigationContainer theme={navTheme} linking={linking}>
      <StatusBar style={theme.name === 'dark' ? 'light' : 'dark'} />
      <RootNavigator />
    </NavigationContainer>
  );
}

export default function App(): React.JSX.Element {
  const transport = useMemo(() => new MockTransport(), []);
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <TransportProvider transport={transport}>
            <QueryClientProvider client={queryClient}>
              <NavigatedApp />
            </QueryClientProvider>
          </TransportProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
