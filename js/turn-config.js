// Optional Metered/Open Relay configuration. Empty values keep STUN-only pairing.
// Use Get credential -> Show API Key in Metered, never the account Secret Key.
// This file is public. Configure the deployed copy without committing real keys.
window.SLIPSTREAM_TURN_CONFIG = {
  domain: '', // Example: your-app.metered.live
  apiKey: '', // Credential-scoped TURN API key
};
