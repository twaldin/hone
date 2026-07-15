#!/usr/bin/env node
// Seed runs from TS source (workspace convention: schema exports raw .ts).
// tsx registers the loader, then the real entry takes over.
import { register } from "tsx/esm/api";
register();
await import(new URL("../src/main.ts", import.meta.url).href);
