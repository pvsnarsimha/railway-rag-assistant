// JS entry for the local Expo module. The app itself talks to it through
// src/utils/cellTower.js (requireOptionalNativeModule("CellTower")), which
// safely returns null on web / Expo Go / iOS.
import { requireOptionalNativeModule } from "expo-modules-core";
export default requireOptionalNativeModule("CellTower");
