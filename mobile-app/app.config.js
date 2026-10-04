// Dynamic Expo config: starts from app.json and injects secrets from the
// build environment so they are never committed. Set GOOGLE_MAPS_API_KEY as
// an EAS secret (`eas secret:create --name GOOGLE_MAPS_API_KEY --value ...`)
// or in your shell before running `eas build --local`.
module.exports = ({ config }) => ({
  ...config,
  android: {
    ...config.android,
    config: {
      ...(config.android && config.android.config),
      googleMaps: { apiKey: process.env.GOOGLE_MAPS_API_KEY || "" },
    },
  },
});
