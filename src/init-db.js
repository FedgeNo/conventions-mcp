// Creates the database (and all tables/triggers/indexes) if it doesn't
// already exist. Safe to run repeatedly. Location is resolved by db.js
// (MEMORY_DB_PATH override, else a checkout-vs-installed default) — this
// stays a thin trigger so there's one source of truth for that logic.
import "./load-env.js";
import { closeDb, getDb, DB_PATH } from "./db.js";

getDb();
closeDb();
console.log(`Database ready at ${DB_PATH}`);
