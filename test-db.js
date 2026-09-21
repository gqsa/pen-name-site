// Test inserting and reading data from our users table
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("database.db");

console.log("=== Testing database operations ===\n");

// 1. INSERT a test user
console.log("Inserting test user...");
db.exec(`INSERT INTO users (username, password) VALUES ('testuser', 'password123')`);
console.log("Inserted!\n");

// 2. READ all users back
console.log("Reading all users:");
const rows = db.prepare("SELECT * FROM users").all();
for (const row of rows) {
  console.log(`  id=${row.id} username=${row.username} password=${row.password}`);
}

// 3. READ a specific user by name
console.log("\nReading 'testuser' specifically:");
const user = db.prepare("SELECT * FROM users WHERE username = ?").get("testuser");
if (user) {
  console.log(`  Found! id=${user.id}, password=${user.password}`);
}

// Clean up the test data so we start fresh
db.exec("DELETE FROM users WHERE username = 'testuser'");
console.log("\nCleaned up test user.");

db.close();
console.log("Done!");
