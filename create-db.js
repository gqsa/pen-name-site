// Step 2: Create our first database with Node's built-in SQLite module
// No npm install needed — node:sqlite comes with Node.js v24+

import { DatabaseSync } from "node:sqlite";

console.log("Creating database file...");

// Open (or create) the database file. If it doesn't exist, SQLite creates it.
const db = new DatabaseSync("database.db");

console.log("Database opened!");

// Create the users table if it doesn't already exist
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    member INTEGER DEFAULT 0
  )
`);

console.log("Users table created!");

// Close the database connection when done
db.close();

console.log("Database closed.");
console.log("\nDone! Check for 'database.db' file in this folder.");
