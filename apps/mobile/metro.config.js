// Expo configures Metro for monorepos automatically. One addition: the Noise library uses
// sodium-universal, which picks native libsodium in Node and the pure-JS sodium-javascript
// elsewhere. Both names are pointed at sodium-javascript explicitly so React Native gets it.
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const sodiumJavascript = require.resolve("sodium-javascript");
const resolveRequest = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === "sodium-native" || moduleName === "sodium-javascript") {
    return { type: "sourceFile", filePath: sodiumJavascript };
  }
  return (resolveRequest ?? context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
