// Creates data/memory.db and all tables/triggers/indexes if they don't
// already exist. Safe to run repeatedly.

import { getDb } from "./db.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "..", "data");
fs.mkdirSync(dataDir, { recursive: true });

getDb();
console.log(`Database ready at ${path.join(dataDir, "memory.db")}`);
