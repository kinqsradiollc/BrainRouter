// Expo (managed) Babel config.
// Reanimated 4 (Expo SDK 54) moved its Babel plugin into react-native-worklets.
// The worklets plugin MUST be last in the plugins list.
module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: ['react-native-worklets/plugin'],
  };
};
