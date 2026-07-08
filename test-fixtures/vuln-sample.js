// Intentional vulnerabilities to exercise the BrainRouter PR-security bot.
const express = require('express');
const { exec } = require('child_process');
const app = express();

// SQL injection — untrusted req.query.id concatenated straight into the query.
app.get('/user', (req, res) => {
  const sql = `SELECT * FROM users WHERE id = ${req.query.id}`;
  db.query(sql, (err, rows) => res.json(rows));
});

// Command injection — untrusted host interpolated into a shell command.
app.get('/ping', (req, res) => exec(`ping -c 1 ${req.query.host}`, (e, out) => res.send(out)));

// Hardcoded credential.
const API_KEY = 'sk_live_ABCDEF1234567890_hardcoded_demo_secret';

module.exports = { app, API_KEY };
