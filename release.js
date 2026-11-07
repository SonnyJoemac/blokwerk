// Maakt de map release/ met update.json. Upload die map naar je update-adres (bijv. GitHub).
// Gebruik: node release.js "korte omschrijving van de wijzigingen"
const fs = require('fs'), crypto = require('crypto');
const FILES = ['blokwerk.js', 'dashboard.html'];
const version = /const VERSION='([^']+)'/.exec(fs.readFileSync('blokwerk.js', 'utf8'))[1];
fs.mkdirSync('release', { recursive: true });
const files = {};
for (const f of FILES) { const b = fs.readFileSync(f); fs.writeFileSync('release/' + f, b); files[f] = { url: f, sha256: crypto.createHash('sha256').update(b).digest('hex') }; }
fs.writeFileSync('release/update.json', JSON.stringify({ version, notes: process.argv[2] || '', files }, null, 2));
console.log('Versie ' + version + ' staat klaar in release/. Upload de hele map en zet het adres van update.json in Blokwerk.');
