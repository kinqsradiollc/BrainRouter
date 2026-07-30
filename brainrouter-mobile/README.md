# BrainRouter Mobile

The companion app monitors and steers hosted agent candidates over the opt-in encrypted relay in BrainRouter Desktop.

## Run

```bash
npm start --workspace brainrouter-mobile
```

In Desktop, open Worktrees, start **Mobile steering**, and create a one-time pairing QR. Scan it from the Pair tab. The desktop and phone establish NaCl box keys; device credentials remain in Keychain/Keystore through Expo SecureStore.

The paired device can monitor candidates, subscribe to terminal output, acquire the single-writer terminal floor, send follow-ups, interrupt, and approve only when its granted scopes allow those methods.
