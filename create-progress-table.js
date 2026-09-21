// Create a table to store user progress (checklist items)
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('database.db');

console.log("Creating progress table...");

db.exec(`
  CREATE TABLE IF NOT EXISTS progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    item TEXT NOT NULL,
    completed INTEGER DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

console.log("Progress table created!");

// Add some default checklist items for all existing users
const users = db.prepare("SELECT id FROM users").all();
for (const user of users) {
  const items = [
    "Learn what a backend is",
    "Understand databases and SQL",
    "Build user registration",
    "Implement login with sessions",
    "Create a protected dashboard"
  ];
  
  for (const item of items) {
    try {
      db.prepare("INSERT INTO progress (user_id, item) VALUES (?, ?)").run(user.id, item);
    } catch (e) {
      // Item already exists for this user, ignore
    }
  }
}

console.log(`Added default checklist items for ${users.length} user(s)`);

db.close();
console.log("Done!");
