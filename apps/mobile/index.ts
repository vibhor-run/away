// Polyfills must load before anything else: the crypto library reads them when first imported.
import "./src/polyfills";
import "expo-router/entry";
