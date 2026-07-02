
const express = require('express');
const pool = require('./db');
const app = express();

app.get('/', (req, res) => {
  res.send('Server is running');
});

app.get('/test-db', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.send(`Database connected! Time: ${result.rows[0].now}`);
  } catch (err) {
    res.status(500).send(`Database error: ${err.message}`);
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});