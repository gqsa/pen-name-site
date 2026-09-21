// Step 8: one-time migration — add a "member" column to the EXISTING users table.
// (New databases made with the updated create-db.js already have this column,
//  so this script only matters for your current database.db.)
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('database.db');

// Check if the column already exists, so this script is safe to run twice.
const columns = db.prepare("PRAGMA table_info(users)").all().map(r => r.name);

if (columns.includes('member')) {
  console.log("'member' column already exists — nothing to do.");
} else {
  // ADD COLUMN only works on existing tables.
  // DEFAULT 0 means every existing user counts as "free" until they become a member.
  db.exec("ALTER TABLE users ADD COLUMN member INTEGER DEFAULT 0");
  console.log("Added 'member' column (0 = free, 1 = member).");
}

// Show what we have now
const users = db.prepare("SELECT id, username, member FROM users").all();
console.log("\nCurrent users:");
for (const u of users) {
  console.log(`  id=${u.id}  ${u.username}  —  ${u.member ? 'member' : 'free'}`);
}

db.close();
console.log("\nDone!");
