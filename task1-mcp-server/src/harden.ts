// Imported first in server.ts: ESM evaluates imports in order, so this runs before the SDK loads.
import { hardenConsole } from "./log.js";
hardenConsole();
