// Runs the Key Results API on a PC: npm run dev -> http://localhost:3002
const app = require('./app');

const PORT = Number(process.env.PORT) || 3002;
app.listen(PORT, () => console.log(`Key Results service on http://localhost:${PORT}`));
