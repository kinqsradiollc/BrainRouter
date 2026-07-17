// Jest config for React Native component/store tests (jest-expo preset).
// NOTE: the pure `domain/**` unit tests are written with node:test and run
// verbatim via `npm run test:domain` (tsx --test) — exactly as the desktop
// runs them — so they pass unchanged (technical-doc.md §10). This Jest project
// covers RN-environment tests (ChatRow renderers, sheets, stores) added in M1.
module.exports = {
  preset: 'jest-expo',
  setupFilesAfterEnv: ['@testing-library/react-native/extend-expect'],
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@react-navigation/.*|react-native-svg|@gorhom/.*|react-native-reanimated|react-native-gesture-handler))',
  ],
  testMatch: ['**/*.test.tsx'],
};
