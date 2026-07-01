// electron-builder `afterSign` hook — notarize the signed macOS app.
//
// Fail-open by design: if the Apple credentials are absent (local dev, CI without
// secrets) OR @electron/notarize isn't installed, it logs and returns so the
// build still produces an (un-notarized) app instead of erroring. Real signed +
// notarized release builds set the three APPLE_* env vars (see build/PACKAGING.md).
//
// Required env for a notarized build:
//   APPLE_ID                     — Apple Developer account email
//   APPLE_APP_SPECIFIC_PASSWORD  — app-specific password (appleid.apple.com)
//   APPLE_TEAM_ID                — 10-char Developer Team ID
// Plus a "Developer ID Application" cert in the keychain (or CSC_LINK/CSC_KEY_PASSWORD).

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;
  if (!appleId || !appleIdPassword || !teamId) {
    console.log(
      '[notarize] APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not all set — skipping notarization.',
    );
    return;
  }

  let notarize;
  try {
    ({ notarize } = require('@electron/notarize'));
  } catch {
    console.log('[notarize] @electron/notarize not installed — run `npm i -D @electron/notarize`. Skipping.');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;
  console.log(`[notarize] submitting ${appName}.app to Apple notary service (notarytool)…`);
  await notarize({ tool: 'notarytool', appPath, appleId, appleIdPassword, teamId });
  console.log('[notarize] notarization complete.');
};
