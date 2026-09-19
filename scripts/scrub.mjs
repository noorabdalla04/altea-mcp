// Scrub personal data out of a React Flight payload while keeping it byte-valid (text rows carry a byte length).
const PII_KEYS = ['displayName', 'photoURL', 'email', 'contactEmail', 'phoneNumber', 'friendlyName', 'birthday', 'gender', 'employer', 'addressFormatted', 'addressLine1', 'addressLine2', 'addressPostalcode', 'addressState', 'addressCity', 'addressLatitude', 'addressLongitude', 'addressPlaceid', 'addressCountryName', 'emergencyContactName', 'emergencyContactEmail', 'emergencyContactRelationship', 'emergencyPhoneNumber', 'cardHolderName', 'expiryDate', 'signature', 'lastSignedIn', 'created', 'modified'];

/** Parse into ordered rows (J = json line, T = length-prefixed text). */
export function parseRows(text) {
  const buf = Buffer.from(text, 'utf8'); const rows = []; let i = 0; const n = buf.length;
  const readUntil = (code) => { const s = i; while (i < n && buf[i] !== code) i++; const out = buf.subarray(s, i).toString('utf8'); i++; return out; };
  while (i < n) {
    const id = readUntil(0x3a); if (i >= n) break;
    if (buf[i] === 0x54) { i++; const len = parseInt(readUntil(0x2c), 16); rows.push({ id, type: 'T', text: buf.subarray(i, i + len).toString('utf8') }); i += len; if (buf[i] === 0x0a) i++; }
    else rows.push({ id, type: 'J', raw: readUntil(0x0a) });
  }
  return rows;
}
export function serializeRows(rows) {
  return rows.map((r) => (r.type === 'T' ? `${r.id}:T${Buffer.byteLength(r.text, 'utf8').toString(16)},${r.text}` : `${r.id}:${r.raw}\n`)).join('');
}
function replaceBalanced(text, keyPattern, replacement) {
  let i = 0, out = '';
  for (;;) {
    const k = text.indexOf(keyPattern, i); if (k < 0) { out += text.slice(i); break; }
    let j = k + keyPattern.length; const open = text[j]; const close = open === '[' ? ']' : '}';
    if (open !== '[' && open !== '{') { out += text.slice(i, j); i = j; continue; }
    let depth = 0, inStr = false, esc = false;
    for (; j < text.length; j++) { const ch = text[j]; if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; } if (ch === '"') inStr = true; else if (ch === open) depth++; else if (ch === close) { depth--; if (depth === 0) { j++; break; } } }
    out += text.slice(i, k) + keyPattern + replacement; i = j;
  }
  return out;
}
const instructorMap = new Map();
const pseudo = (name) => { if (!instructorMap.has(name)) instructorMap.set(name, `Instructor ${String.fromCharCode(65 + (instructorMap.size % 26))}${instructorMap.size >= 26 ? Math.floor(instructorMap.size / 26) : ''}`); return instructorMap.get(name); };
/** Staff are real people: replace their display names with stable placeholders and drop their bios. */
function pseudonymiseInstructors(t) {
  const rewrite = (obj) => obj
    .replace(/"(name|label)":"((?:[^"\\]|\\.)*)"/g, (m, k, v) => `"${k}":"${pseudo(v)}"`)
    .replace(/"description":"(?:[^"\\]|\\.)*"/g, '"description":"[redacted]"');
  // 1. flat objects with a res_ id, any key order
  t = t.replace(/\{[^{}]*"id":"res_[A-Za-z0-9]+"[^{}]*\}/g, rewrite);
  // 2. flat objects that carry a staff avatar (already replaced by the placeholder URL)
  t = t.replace(/\{[^{}]*"imageUrl":"https:\/\/example\.invalid\/avatar\.png"[^{}]*\}/g, rewrite);
  // 3. anything keyed by a res_ id inside a resources map: {"res_…":{…}}
  t = t.replace(/("res_[A-Za-z0-9]+":)(\{[^{}]*\})/g, (m, k, obj) => k + rewrite(obj));
  return t;
}

/** Scrub a payload: user ids, booking/perk/payment ids, PII keys, payment methods, linked accounts, embedded images, staff names. */
export function scrubRSC(text) {
  const uid = (text.match(/"currentUser":\{[^}]*?"id":"([^"]+)"/) || text.match(/"uid":"([^"]+)"/) || [])[1];
  const rows = parseRows(text);
  for (const r of rows) {
    if (r.type === 'T') { if (/^data:/i.test(r.text) || /^[A-Za-z0-9+/=]{200,}$/.test(r.text)) r.text = '[redacted]'; continue; }
    let t = r.raw;
    if (uid) t = t.split(uid).join('usr_test');
    t = t.replace(/usrprk_[A-Za-z0-9]+/g, 'usrprk_test').replace(/bkg_[A-Za-z0-9]+/g, 'bkg_test').replace(/pm_[A-Za-z0-9]{8,}/g, 'pm_test').replace(/wli_[A-Za-z0-9]+/g, 'wli_test');
    t = t.replace(/https:\/\/storage\.googleapis\.com\/greco-user-public\/[^"]+/g, 'https://example.invalid/avatar.png');
    t = replaceBalanced(t, '"paymentMethods":', '[{"id":"pm_test","type":"user","label":"**** 0000","model":"visa","userId":"usr_test","default":1,"details":"01/30","gateway":"stripe","cardHolderName":"[redacted]","expired":false}]');
    t = replaceBalanced(t, '"linkedAccounts":', '[]');
    for (const key of PII_KEYS) t = t.replace(new RegExp(`"${key}":"(?:[^"\\\\]|\\\\.)*"`, 'g'), `"${key}":"[redacted]"`);
    t = t.replace(/data:image\/[a-z]+;base64,[A-Za-z0-9+/=]+/g, '[redacted]');
    t = pseudonymiseInstructors(t);
    r.raw = t;
  }
  return serializeRows(rows);
}
