const REPEAT = 0;

const SQL = [
  `CREATE TABLE IF NOT EXISTS devices (
    device_id TEXT PRIMARY KEY,
    section TEXT NOT NULL,
    patrol_no TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS mobile_map (
    device_id TEXT PRIMARY KEY,
    mobile TEXT NOT NULL,
    mobile2 TEXT DEFAULT '',
    person_name TEXT DEFAULT '',
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS ignored_devices (
    device_id TEXT PRIMARY KEY,
    ignored_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS telemetry (
    device_id TEXT PRIMARY KEY,
    end_time TEXT,
    end_ts INTEGER,
    km_run TEXT,
    end_address TEXT,
    battery TEXT,
    start_time TEXT,
    gps_on INTEGER,
    direction TEXT,
    direction_updated_at TEXT,
    history_km REAL,
    history_checked_at TEXT,
    payload TEXT,
    received_at TEXT DEFAULT CURRENT_TIMESTAMP,
    last_alert_at INTEGER,
    last_night_alert_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`
];

const J = (v, s = 200) =>
  new Response(JSON.stringify(v), {
    status: s,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store"
    }
  });

const S = v => String(v ?? "").trim();
const ID = v => /^\d{4,12}$/.test(S(v));
const SEC = v => ["RJK", "RG", "CH"].includes(S(v).toUpperCase());
const MASK = v => "******" + S(v).slice(-4);

// GPS-ID keyed patrol beat boundaries copied from Patrolling Dashboard v2.1.0.
const BEAT_BY_GPS_ID = Object.freeze({
  "88338": ["5/0", "9/0"],
  "88303": ["9/0", "13/0"],
  "88294": ["13/0", "17/0"],
  "88280": ["17/0", "21/0"],
  "88242": ["21/0", "27/0"],
  "88235": ["27/0", "33/0"],
  "88246": ["33/0", "37/0"],
  "88266": ["37/0", "41/0"],
  "88221": ["41/0", "45/0"],
  "87986": ["45/0", "49/0"],
  "88176": ["49/0", "53/0"],
  "88274": ["53/0", "57/0"],
  "88096": ["57/0", "61/0"],
  "88216": ["61/0", "65/0"],
  "88088": ["65/0", "69/0"],
  "88262": ["69/785", "74/0"],
  "88295": ["74/0", "78/0"],
  "88317": ["78/0", "82/0"],
  "88319": ["82/0", "86/0"],
  "88254": ["86/0", "90/0"],
  "88802": ["90/0", "94/0"],
  "88209": ["94/0", "98/0"],
  "88349": ["98/0", "102/0"],
  "83597": ["102/0", "106/0"],
  "88336": ["106/0", "110/0"],
  "87657": ["110/0", "114/0"],
  "88638": ["114/0", "118/0"],
  "88059": ["118/0", "122/0"],
  "88208": ["122/0", "126/0"],
  "88347": ["126/0", "130/0"],
  "88147": ["130/0", "134/0"],
  "88279": ["134/0", "138/0"],
  "88244": ["138/0", "142/0"],
  "88495": ["142/0", "146/0"],
  "88243": ["146/0", "150/0"],
  "88171": ["150/0", "153/0"],
  "88067": ["1/10", "5/10"],
  "88268": ["5/10", "9/10"],
  "87989": ["9/10", "13/10"],
  "88308": ["13/10", "17/10"],
  "88213": ["17/10", "21/10"],
  "88045": ["21/10", "25/10"],
  "88044": ["25/10", "29/10"],
  "88223": ["29/10", "33/10"],
  "87980": ["33/10", "37/10"],
  "88214": ["37/10", "41/10"],
  "88203": ["41/10", "43/5"]
});
function formatBeat(deviceId) {
  const beat = BEAT_BY_GPS_ID[S(deviceId)];
  return beat ? beat[0] + " – " + beat[1] : "Not mapped";
}
function formatDirection(direction) {
  if (direction === "up") return "⟹ UP (railway KM increasing)";
  if (direction === "down") return "⟸ DOWN (railway KM decreasing)";
  return "Unknown (insufficient/unclear GPS points)";
}


function parseKmValue(value) {
  const match = String(value ?? "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const number = Number(match[0]);
  return Number.isFinite(number) ? number : null;
}
function kmDifferenceMeters(firstKm, secondKm) {
  const first = parseKmValue(firstKm);
  const second = parseKmValue(secondKm);
  if (first === null || second === null) return null;
  return Math.abs(Math.round(first * 1000) - Math.round(second * 1000));
}
function formatKmRun(kmRun, historyKm) {
  const reportKm = parseKmValue(kmRun);
  if (reportKm === null) return S(kmRun) || "-";
  const display = reportKm.toFixed(2) + " KM";
  // NULL/empty means History Distance was not fetched; never coerce it to 0.
  if (historyKm === null || historyKm === undefined || String(historyKm).trim() === "") {
    return display;
  }
  const history = Number(historyKm);
  if (Number.isFinite(history) && history >= 0 && kmDifferenceMeters(reportKm, history) >= 200) {
    return display + " (History: " + history.toFixed(2) + " KM)";
  }
  return display;
}

function phoneEntities(text) {
  const entities = [];
  for (const match of String(text).matchAll(/\+91\d{10}/g)) {
    entities.push({ type: "phone_number", offset: match.index, length: match[0].length });
  }
  return entities;
}

async function init(db) {
  for (const q of SQL) {
    await db.prepare(q).run();
  }

  try {
    await db.prepare("ALTER TABLE mobile_map ADD COLUMN mobile2 TEXT DEFAULT ''").run();
  } catch (e) {
    if (!String(e).toLowerCase().includes("duplicate column")) throw e;
  }
  for (const [column, definition] of [["direction", "TEXT"], ["direction_updated_at", "TEXT"], ["history_km", "REAL"], ["history_checked_at", "TEXT"]]) {
    try {
      await db.prepare("ALTER TABLE telemetry ADD COLUMN " + column + " " + definition).run();
    } catch (e) {
      if (!String(e).toLowerCase().includes("duplicate column")) throw e;
    }
  }
  await db.prepare(
    "INSERT OR IGNORE INTO settings(key,value) VALUES('monitor','off')"
  ).run();
}

async function setting(db, k, d = "") {
  const r = await db.prepare(
    "SELECT value FROM settings WHERE key=?"
  ).bind(k).first();

  return r ? r.value : d;
}

async function set(db, k, v) {
  await db.prepare(`
    INSERT INTO settings(key,value,updated_at)
    VALUES(?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET
    value=excluded.value,
    updated_at=CURRENT_TIMESTAMP
  `).bind(k, String(v)).run();
}

async function seedTelemetry(db, id) {
  await db.prepare(
    "INSERT OR IGNORE INTO telemetry(device_id) VALUES(?)"
  ).bind(id).run();
}

async function send(env, chat, text, entities = []) {
  if (!env.TELEGRAM_BOT_TOKEN || !chat) return false;
  if (!entities.length) entities = phoneEntities(text);

  const r = await fetch(
    "https://api.telegram.org/bot" +
    env.TELEGRAM_BOT_TOKEN +
    "/sendMessage",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chat,
        text,
        ...(entities.length ? { entities } : {}),
        disable_web_page_preview: true
      })
    }
  );

  const d = await r.json();

  if (!d.ok) {
    console.error("Telegram error", JSON.stringify(d).slice(0, 300));
  }

  return !!d.ok;
}

async function sendKeyboard(env, chat, text, keyboard, entities = []) {
  if (!env.TELEGRAM_BOT_TOKEN || !chat) return false;
  if (!entities.length) entities = phoneEntities(text);
  const r = await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/sendMessage", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chat, text, ...(entities.length ? { entities } : {}), reply_markup: { inline_keyboard: keyboard }, disable_web_page_preview: true })
  });
  const d = await r.json();
  if (!d.ok) console.error("Telegram keyboard error", JSON.stringify(d).slice(0, 300));
  return !!d.ok;
}
async function setTelegramMenu(env, chat) {
  if (!env.TELEGRAM_BOT_TOKEN) return false;
  const base = "https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/";
  const commands = [
    {command:"start",description:"Open GPS controller menu"},
    {command:"s",description:"GPS status by section/device"},
    {command:"less",description:"Find devices below KM Run"},
    {command:"devices",description:"List active GPS devices"},
    {command:"status",description:"Show a device status"},
    {command:"sync",description:"Refresh RILAPP GPS data"},
    {command:"help",description:"Show all commands"}
  ];
  const c = await fetch(base+"setMyCommands",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({commands})});
  const cd = await c.json();
  // Set the default menu button for every private chat, then override this chat explicitly.
  const m = await fetch(base+"setChatMenuButton",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({menu_button:{type:"commands"}})});
  const md = await m.json();
  const personal = await fetch(base+"setChatMenuButton",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({chat_id:chat,menu_button:{type:"commands"}})});
  const pd = await personal.json();
  const verify = await fetch(base+"getChatMenuButton?chat_id="+encodeURIComponent(String(chat)));
  const vd = await verify.json();
  const menuOk = !!cd.ok && !!md.ok && !!pd.ok && !!vd.ok && vd.result?.type === "commands";
  if (!menuOk) console.error("Telegram menu setup/verify failed",JSON.stringify({commands:cd,default:md,chat:pd,verify:vd}).slice(0,900));
  return menuOk;
}

async function answerCallback(env, callbackId, text = "") {
  if (!env.TELEGRAM_BOT_TOKEN || !callbackId) return;
  await fetch("https://api.telegram.org/bot" + env.TELEGRAM_BOT_TOKEN + "/answerCallbackQuery", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackId, text })
  });
}
async function showSectionPicker(env, chat) {
  await sendKeyboard(env, chat, "GPS Status - Select Section", [[
    { text: "CH", callback_data: "gps:sec:CH" },
    { text: "RG", callback_data: "gps:sec:RG" },
    { text: "RJK", callback_data: "gps:sec:RJK" }
  ]]);
}
async function showDevicePicker(env, db, chat, section) {
  if (!SEC(section)) return;
  const result = await db.prepare("SELECT device_id,patrol_no FROM devices WHERE active=1 AND section=? ORDER BY patrol_no,device_id").bind(section).all();
  const rows = []; let row = [];
  for (const d of result.results) {
    row.push({ text: String(d.patrol_no || "").replace(/^P/i, "") + " (" + d.device_id + ")", callback_data: "gps:dev:" + section + ":" + d.device_id });
    if (row.length === 2) { rows.push(row); row = []; }
  }
  if (row.length) rows.push(row);
  rows.push([{ text: "Back to Sections", callback_data: "gps:sections" }]);
  await sendKeyboard(env, chat, section + " - Select Patrol / Device (" + result.results.length + ")", rows);
}
async function showDeviceStatus(env, db, chat, section, id) {
  const r = await db.prepare(`
    SELECT d.*,m.mobile,m.mobile2,m.person_name,t.end_time,t.end_ts,t.km_run,
    t.end_address,t.battery,t.gps_on,t.received_at,t.direction,t.direction_updated_at,
    t.history_km,t.history_checked_at
    FROM devices d LEFT JOIN mobile_map m ON m.device_id=d.device_id
    LEFT JOIN telemetry t ON t.device_id=d.device_id
    WHERE d.active=1 AND d.section=? AND d.device_id=?
  `).bind(section, id).first();
  if (!r) return send(env, chat, "Device not found in " + section + ".");
  const age = r.end_ts ? Math.max(0, Math.round((Date.now() - r.end_ts) / 60000)) + " min ago" : "no GPS data";
  const phone = formatDialableMobile(r.mobile);
  const phone2 = formatDialableMobile(r.mobile2);
  const text = [
    r.section + " " + r.patrol_no + " | " + r.device_id,
    "GPS: " + (r.gps_on === null ? "unknown" : r.gps_on ? "ON" : "OFF"),
    "End: " + (r.end_time || "No data") + " (" + age + ")",
    "KM Run: " + formatKmRun(r.km_run, r.history_km), "Address: " + (r.end_address || "-"),
    "Battery: " + (r.battery || "-"),
    "Beat: " + formatBeat(r.device_id),
    "Direction: " + formatDirection(r.direction),
    "Direction checked: " + (r.direction_updated_at || "never"),
    "Phone 1: " + (phone || "not mapped"),
    "Phone 2: " + (phone2 || "not mapped")
  ].join("\n");
  const entities = [];
  if (phone) entities.push({ type: "phone_number", offset: text.indexOf("Phone 1: ") + "Phone 1: ".length, length: phone.length });
  if (phone2) entities.push({ type: "phone_number", offset: text.indexOf("Phone 2: ") + "Phone 2: ".length, length: phone2.length });
  await sendKeyboard(env, chat, text, [
    [{ text: "Back to " + section + " Devices", callback_data: "gps:sec:" + section }],
    [{ text: "Back to Sections", callback_data: "gps:sections" }]
  ], entities);
}
async function handleGpsCallback(env, db, query) {
  const from = S(query.from?.id);
  if (!env.TELEGRAM_ADMIN_ID || from !== S(env.TELEGRAM_ADMIN_ID)) {
    await answerCallback(env, query.id, "Admin only"); return;
  }
  const data = S(query.data).split(":");
  const chat = query.message?.chat?.id;
  if (!chat || data[0] !== "gps") { await answerCallback(env, query.id); return; }
  await answerCallback(env, query.id);
  if (data[1] === "sections") return showSectionPicker(env, chat);
  if (data[1] === "sec" && SEC(data[2])) return showDevicePicker(env, db, chat, data[2]);
  if (data[1] === "dev" && SEC(data[2]) && ID(data[3])) return showDeviceStatus(env, db, chat, data[2], data[3]);
}

function formatDialableMobile(value) {
  const raw = String(value || "").trim();
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return "+91" + digits;
  if (digits.length === 11 && digits.startsWith("0")) return "+91" + digits.slice(1);
  if (digits.length === 12 && digits.startsWith("91")) return "+" + digits;
  if (raw.startsWith("+") && digits.length >= 8 && digits.length <= 15) return "+" + digits;
  return "";
}
async function sendLessResults(env, db, chat, limit) {
  const expr = "CAST(REPLACE(REPLACE(TRIM(t.km_run),' km',''),',','.') AS REAL)";
  const result = await db.prepare(
    "SELECT d.device_id,d.section,d.patrol_no,t.km_run,t.history_km,t.end_time FROM devices d JOIN telemetry t ON t.device_id=d.device_id " +
    "LEFT JOIN ignored_devices i ON i.device_id=d.device_id WHERE d.active=1 AND i.device_id IS NULL " +
    "AND t.km_run IS NOT NULL AND TRIM(t.km_run)<>'' AND " + expr + " < ? ORDER BY " + expr + ",d.section,d.patrol_no"
  ).bind(limit).all();
  if (!result.results.length) return send(env,chat,"No active device found with KM Run below "+limit.toFixed(2)+" km.");
  const lines=["DEVICES BELOW "+limit.toFixed(2)+" KM RUN","Found: "+result.results.length,""];
  for (const x of result.results) {
    lines.push(x.section+" "+x.patrol_no+" | "+x.device_id+" | KM Run: "+formatKmRun(x.km_run,x.history_km)+" | End: "+(x.end_time||"-"));
  }
  await send(env,chat,lines.join("\n"));
}

async function cmd(env, db, msg) {
  const chat = msg.chat?.id;
  const from = S(msg.from?.id);

  if (!chat) return;

  if (!env.TELEGRAM_ADMIN_ID ||
      from !== S(env.TELEGRAM_ADMIN_ID)) {
    await send(env, chat, "Access denied: admin only.");
    return;
  }

  const full = S(msg.text);
  const line = full.split("\n",1)[0];
  const m = line.match(/^\/(\w+)(?:@\w+)?(?:\s+(.*))?$/);
  const pendingKey = "less_wait:" + String(chat);
  if (!m && await setting(db,pendingKey,"") === "on") {
    const value=Number(full.trim());
    if (!Number.isFinite(value)||value<0||!/^\d+(?:\.\d{1,2})?$/.test(full.trim())) {
      await send(env,chat,"Invalid KM. Enter up to 2 decimal places, e.g. 12.50, or /cancel.");
      return;
    }
    await set(db,pendingKey,"off");
    return sendLessResults(env,db,chat,value);
  }
  if (!m) return;
  const c=m[1].toLowerCase();
  const a=m[2]||"";
  const p=a.trim()?a.trim().split(/\s+/):[];
  const id=p[0]||"";

  try {

    if (c === "start" || c === "help") {
      await setTelegramMenu(env, chat);
      await send(env, chat,
`Railway GPS Controller

/devices [RJK|RG|CH]
/linkdevice SECTION P# ID\n/bulklink SECTION (then P# ID on each line)
/updatedevice ID SECTION P#
/removedevice ID
/ignore ID
/unignore ID
/ignored
/importdevices
/mapmobile JSON (DEVICE_ID: [PHONE1, PHONE2])
/mobile ID
/unmapmobile ID
/status ID
/deviceinfo ID
/s RJK|RG|CH [P#|ID] (section, patrol or ID status)
/less (then send KM, e.g. 12.50)
/monitor on|off
/stale [MINUTES]
/pending
/health
/sync (manual RILAPP refresh)`);
      return;
    }

    if (c === "menu") {
      const ok=await setTelegramMenu(env,chat);
      await send(env,chat,ok?"Telegram Menu button enabled.":"Could not configure Telegram Menu button.");
      return;
    }
    if (c === "cancel") { await set(db,pendingKey,"off"); await send(env,chat,"Cancelled."); return; }
    if (c === "less") {
      const direct=a.trim();
      if (direct) {
        if (!/^\d+(?:\.\d{1,2})?$/.test(direct)||!Number.isFinite(Number(direct))) {
          await send(env,chat,"Format: /less 12.50 (maximum 2 decimal places)."); return;
        }
        await set(db,pendingKey,"off");
        await sendLessResults(env,db,chat,Number(direct));
      } else {
        await set(db,pendingKey,"on");
        await send(env,chat,"Send KM limit, e.g. 12.50. Up to 2 decimal places. Send /cancel to cancel.");
      }
      return;
    }

    if (c === "sync") {
      await send(env, chat, "Starting manual RILAPP sync...");
      try {
        const result = await runRilappFeed(env);
        if (result && result.ok) {
          await set(db, "last_feed_error", "");
          await send(env, chat,
            "RILAPP SYNC SUCCESS\nRows updated: " + result.rows +
            "\nBattery matches: " + result.batteries +
            "\nGPS History checked: " + (result.directions?.checked || 0) +
            " | UP: " + (result.directions?.up || 0) +
            " | DOWN: " + (result.directions?.down || 0) +
            " | Unknown: " + (result.directions?.unknown || 0) +
            " | Failed: " + (result.directions?.failed || 0) +
            "\nDistance History checked: " + (result.history?.checked || 0) +
            " | Difference >= 0.20 KM: " + (result.history?.discrepancies || 0) +
            " | Failed: " + (result.history?.failed || 0) +
            " | Unavailable: " + (result.history?.unavailable || 0) +
            "\nWindow: " + result.window
          );
        } else {
          await send(env, chat, "RILAPP SYNC SKIPPED: " + (result.reason || "unknown reason"));
        }
      } catch (error) {
        const message = String(error && error.message ? error.message : error).slice(0, 3500);
        await set(db, "last_feed_error", message);
        await send(env, chat, "RILAPP SYNC FAILED\n" + message);
      }
      return;
    }

    if (c === "health") {
      const n = await db.prepare(
        "SELECT COUNT(*) n FROM devices WHERE active=1"
      ).first();

      await send(env, chat,
`Worker online
D1 connected
Active devices: ${n.n}
Monitoring: ${await setting(db, "monitor", "off")}
Bot token: ${env.TELEGRAM_BOT_TOKEN ? "configured" : "missing"}
Admin ID: ${env.TELEGRAM_ADMIN_ID ? "configured" : "missing"}
Last feed: ${await setting(db, "last_ingest", "never")}
Last feed rows: ${await setting(db, "last_rilapp_rows", "unknown")}
Last attempt: ${await setting(db, "last_feed_attempt", "unknown")}
Feed error: ${await setting(db, "last_feed_error", "none") || "none"}`);

      return;
    }

    if (c === "devices") {
      const s = S(a).toUpperCase();

      const r = s && SEC(s)
        ? await db.prepare(
            "SELECT device_id,section,patrol_no FROM devices WHERE active=1 AND section=? ORDER BY patrol_no"
          ).bind(s).all()
        : await db.prepare(
            "SELECT device_id,section,patrol_no FROM devices WHERE active=1 ORDER BY section,patrol_no"
          ).all();

      await send(env, chat,
        r.results.length
          ? r.results.map(x =>
              `${x.section} ${x.patrol_no} ${x.device_id}`
            ).join("\n")
          : "No active devices."
      );

      return;
    }

    if (c === "linkdevice") {
      const [s, pat, d] = p;

      if (!SEC(s) ||
          !/^P\d{1,2}$/i.test(pat || "") ||
          !ID(d)) {
        await send(env, chat,
          "Format: /linkdevice RJK P11 88336");
        return;
      }

      await db.prepare(`
        INSERT INTO devices(device_id,section,patrol_no,active,updated_at)
        VALUES(?,?,?,1,CURRENT_TIMESTAMP)
        ON CONFLICT(device_id) DO UPDATE SET
        section=excluded.section,
        patrol_no=excluded.patrol_no,
        active=1,
        updated_at=CURRENT_TIMESTAMP
      `).bind(d, s.toUpperCase(), pat.toUpperCase()).run();

      await seedTelemetry(db, d);

      await send(env, chat, "Saved " + s.toUpperCase() +
        " " + pat.toUpperCase() + " " + d);

      return;
    }

    if (c === "bulklink") {
      const section = S(p[0]).toUpperCase();
      if (!SEC(section)) {
        await send(env, chat,
          "Format:\n/bulklink CH\nP1 88338\nP2 88303");
        return;
      }

      const rows = full.split(/\r?\n/).slice(1)
        .map(line => line.trim())
        .filter(Boolean)
        .map(line => line.split(/\s+/));

      if (!rows.length || rows.length > 70 ||
          rows.some(row => row.length !== 2 ||
            !/^P\d{1,2}$/i.test(row[0]) || !ID(row[1]))) {
        await send(env, chat,
          "Invalid list. Send 1-70 lines, each as P# DEVICE_ID.\nExample:\n/bulklink CH\nP1 88338\nP2 88303");
        return;
      }

      const patrols = rows.map(row => row[0].toUpperCase());
      const ids = rows.map(row => row[1]);
      if (new Set(patrols).size !== patrols.length ||
          new Set(ids).size !== ids.length) {
        await send(env, chat,
          "Duplicate patrol number or device ID found. No devices were changed.");
        return;
      }

      const statements = [];
      for (const [patrol, device] of rows.map(row => [row[0].toUpperCase(), row[1]])) {
        statements.push(db.prepare(`
          INSERT INTO devices(device_id,section,patrol_no,active,updated_at)
          VALUES(?,?,?,1,CURRENT_TIMESTAMP)
          ON CONFLICT(device_id) DO UPDATE SET
          section=excluded.section,
          patrol_no=excluded.patrol_no,
          active=1,
          updated_at=CURRENT_TIMESTAMP
        `).bind(device, section, patrol));
        statements.push(db.prepare(
          "INSERT OR IGNORE INTO telemetry(device_id) VALUES(?)"
        ).bind(device));
      }

      await db.batch(statements);
      await send(env, chat,
        "Successfully linked " + rows.length + " devices to " + section + " SECTION.\n\n" +
        rows.map(row => section + " " + row[0].toUpperCase() + " " + row[1]).join("\n"));
      return;
    }

    if (c === "updatedevice") {
      const [d, s, pat] = p;

      if (!ID(d) || !SEC(s) ||
          !/^P\d{1,2}$/i.test(pat || "")) {
        await send(env, chat,
          "Format: /updatedevice 88336 RG P10");
        return;
      }

      const r = await db.prepare(`
        UPDATE devices
        SET section=?,patrol_no=?,active=1,
        updated_at=CURRENT_TIMESTAMP
        WHERE device_id=?
      `).bind(s.toUpperCase(), pat.toUpperCase(), d).run();

      if (r.meta.changes) await seedTelemetry(db, d);

      await send(env, chat,
        r.meta.changes ? "Updated " + d :
        "Device not found; use /linkdevice."
      );

      return;
    }

    if (c === "removedevice") {
      if (!ID(id)) {
        await send(env, chat, "Format: /removedevice 88336");
        return;
      }

      const r = await db.prepare(
        "UPDATE devices SET active=0,updated_at=CURRENT_TIMESTAMP WHERE device_id=?"
      ).bind(id).run();

      await send(env, chat,
        r.meta.changes
          ? "Deactivated " + id
          : "Device not found."
      );

      return;
    }

    if (c === "ignore" || c === "unignore") {
      if (!ID(id)) {
        await send(env, chat, "Provide a numeric device ID.");
        return;
      }

      if (c === "ignore") {
        await db.prepare(
          "INSERT OR IGNORE INTO ignored_devices(device_id) VALUES(?)"
        ).bind(id).run();
      } else {
        await db.prepare(
          "DELETE FROM ignored_devices WHERE device_id=?"
        ).bind(id).run();
      }

      await send(env, chat,
        c === "ignore"
          ? "Alerts ignored: " + id
          : "Alerts resumed: " + id
      );

      return;
    }

    if (c === "ignored") {
      const r = await db.prepare(
        "SELECT device_id FROM ignored_devices ORDER BY device_id"
      ).all();

      await send(env, chat,
        r.results.length
          ? r.results.map(x => x.device_id).join("\n")
          : "Ignore list empty."
      );

      return;
    }

    if (c === "stale") {
      const current = Number(await setting(db, "stale_minutes", "30")) || 30;
      if (!p.length) {
        await send(env, chat, "Device update threshold: " + current + " minutes\nSet with /stale 15 (1-1440 minutes).");
        return;
      }
      const minutes = Number(p[0]);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
        await send(env, chat, "Use /stale MINUTES (1-1440).");
        return;
      }
      await set(db, "stale_minutes", minutes);
      await send(env, chat, "Device update threshold set to " + minutes + " minutes.");
      return;
    }

    if (c === "monitor") {
      const v = S(p[0]).toLowerCase();

      if (!["on", "off"].includes(v)) {
        await send(env, chat, "Use /monitor on or /monitor off");
        return;
      }

      await set(db, "monitor", v);
      await send(env, chat, "Monitoring " + v.toUpperCase());

      return;
    }

    if (c === "importdevices" || c === "mapmobile") {
      const raw = full.includes("\n")
        ? full.slice(full.indexOf("\n") + 1).trim()
        : a.trim();

      let data;

      try {
        data = JSON.parse(raw);
      } catch {
        await send(env, chat,
          "JSON invalid. Send command then JSON on next line.");
        return;
      }

      if (c === "mapmobile") {
        const arr = Array.isArray(data)
          ? data
          : Object.entries(data || {}).map(([device_id, v]) =>
              Array.isArray(v)
                ? { device_id, mobile: v[0], mobile2: v[1] }
                : typeof v === "string"
                  ? { device_id, mobile: v }
                  : { device_id, ...v }
            );

        if (!arr.length) {
          await send(env, chat, "Mapping JSON empty.");
          return;
        }

        const rows = [];

        for (const x of arr) {
          const d = S(x.device_id || x.id);
          const phone = S(x.mobile || x.phone || x.mobile1).replace(/[\s+-]/g, "");
          const phone2 = S(x.mobile2 || x.phone2).replace(/[\s+-]/g, "");

          if (!ID(d) || !/^\d{10,15}$/.test(phone) ||
              (phone2 && !/^\d{10,15}$/.test(phone2))) {
            await send(env, chat, "Invalid mobile mapping JSON.");
            return;
          }

          rows.push({ d, phone, phone2, name: S(x.name || x.person_name) });
        }

        await db.batch(rows.map(x =>
          db.prepare(`
            INSERT INTO mobile_map(device_id,mobile,mobile2,person_name,updated_at)
            VALUES(?,?,?,?,CURRENT_TIMESTAMP)
            ON CONFLICT(device_id) DO UPDATE SET
            mobile=excluded.mobile,
            mobile2=excluded.mobile2,
            person_name=excluded.person_name,
            updated_at=CURRENT_TIMESTAMP
          `).bind(x.d, x.phone, x.phone2, x.name)
        ));

        await send(env, chat,
          "Mobile mappings saved: " + rows.length + "\n" +
          rows.map(x => x.d + " -> " + MASK(x.phone) + (x.phone2 ? " / " + MASK(x.phone2) : "")).join("\n")
        );

        return;
      }

      if (!Array.isArray(data) || !data.length) {
        await send(env, chat, "Expected a non-empty JSON array.");
        return;
      }

      const rows = [];

      for (const x of data) {
        const d = S(x.device_id || x.id);
        const s = S(x.section).toUpperCase();
        const pat = S(x.patrol_no || x.patrol).toUpperCase();

        if (!ID(d) || !SEC(s) || !/^P\d{1,2}$/.test(pat)) {
          await send(env, chat, "Invalid device JSON.");
          return;
        }

        rows.push({ d, s, pat });
      }

      await db.batch(rows.flatMap(x => [
        db.prepare(`
          INSERT INTO devices(device_id,section,patrol_no,active,updated_at)
          VALUES(?,?,?,1,CURRENT_TIMESTAMP)
          ON CONFLICT(device_id) DO UPDATE SET
          section=excluded.section,
          patrol_no=excluded.patrol_no,
          active=1,
          updated_at=CURRENT_TIMESTAMP
        `).bind(x.d, x.s, x.pat),

        db.prepare(
          "INSERT OR IGNORE INTO telemetry(device_id) VALUES(?)"
        ).bind(x.d)
      ]));

      await send(env, chat, "Devices imported/updated: " + rows.length);
      return;
    }

    if (c === "mobile" || c === "unmapmobile") {
      if (!ID(id)) {
        await send(env, chat, "Use /" + c + " DEVICE_ID");
        return;
      }

      if (c === "unmapmobile") {
        const r = await db.prepare(
          "DELETE FROM mobile_map WHERE device_id=?"
        ).bind(id).run();

        await send(env, chat,
          r.meta.changes ? "Mapping removed." : "Mapping not found."
        );

        return;
      }

      const r = await db.prepare(
        "SELECT mobile,mobile2,person_name FROM mobile_map WHERE device_id=?"
      ).bind(id).first();

      await send(env, chat,
        r
          ? id + " -> " + MASK(r.mobile) + (r.mobile2 ? " / " + MASK(r.mobile2) : "") +
            (r.person_name ? " (" + r.person_name + ")" : "")
          : "No mobile mapped."
      );

      return;
    }

    if (c === "s" && !p.length) {
      await showSectionPicker(env, chat);
      return;
    }

    if (["rg", "ch", "rjk"].includes(c)) {
      const section = c.toUpperCase();
      if (!p.length) {
        await showDevicePicker(env, db, chat, section);
        return;
      }
      const patrolArg = S(p[0]).toUpperCase().replace(/^P/, "");
      if (!/^\d{1,3}$/.test(patrolArg)) {
        await send(env, chat, "Use /" + c + " or /" + c + " 1 (patrol number without P).");
        return;
      }
      const result = await db.prepare(
        "SELECT device_id FROM devices WHERE active=1 AND section=? AND CAST(REPLACE(UPPER(patrol_no),'P','') AS INTEGER)=? ORDER BY device_id LIMIT 1"
      ).bind(section, Number(patrolArg)).first();
      if (!result) {
        await send(env, chat, "No active device found: " + section + " " + patrolArg);
        return;
      }
      await showDeviceStatus(env, db, chat, section, result.device_id);
      return;
    }

    if (c === "s") {
      const first = S(p[0]).toUpperCase();
      const second = S(p[1]).toUpperCase();
      let where = "d.active=1";
      const args = [];
      let label = "ALL SECTIONS";

      if (SEC(first)) {
        where += " AND d.section=?";
        args.push(first);
        label = first + " SECTION";

        if (second) {
          if (ID(second)) {
            where += " AND d.device_id=?";
            args.push(second);
            label += " | ID " + second;
          } else if (/^P\d{1,3}$/.test(second)) {
            where += " AND UPPER(d.patrol_no)=?";
            args.push(second);
            label += " | " + second;
          } else {
            await send(env, chat, "Use /s CH, /s CH P1, or /s CH 88338");
            return;
          }
        }
      } else if (ID(first) && !second) {
        where += " AND d.device_id=?";
        args.push(first);
        label = "DEVICE ID " + first;
      } else {
        await send(env, chat, "Use /s RJK|RG|CH, /s CH P1, /s CH 88338, or /s 88338");
        return;
      }

      const result = await db.prepare(`
        SELECT d.device_id,d.section,d.patrol_no,d.active,
        m.mobile,m.mobile2,m.person_name,t.end_time,t.end_ts,t.km_run,
        t.end_address,t.battery,t.gps_on,t.received_at,t.direction,t.direction_updated_at,
        t.history_km,t.history_checked_at
        FROM devices d
        LEFT JOIN mobile_map m ON m.device_id=d.device_id
        LEFT JOIN telemetry t ON t.device_id=d.device_id
        WHERE ` + where + `
        ORDER BY d.section,d.patrol_no,d.device_id
      `).bind(...args).all();

      if (!result.results.length) {
        await send(env, chat, "No matching active device found: " + label);
        return;
      }

      const lines = result.results.map(r => {
        const age = r.end_ts
          ? Math.max(0, Math.round((Date.now() - r.end_ts) / 60000)) + " min ago"
          : "no GPS data";
        const phone = formatDialableMobile(r.mobile);
        const phone2 = formatDialableMobile(r.mobile2);
        return [
          r.section + " " + r.patrol_no + " | " + r.device_id,
          "GPS: " + (r.gps_on === null ? "unknown" : r.gps_on ? "ON" : "OFF"),
          "End: " + (r.end_time || "No data") + " (" + age + ")",
          "KM Run: " + formatKmRun(r.km_run, r.history_km),
          "Address: " + (r.end_address || "-"),
          "Battery: " + (r.battery || "-"),
          "Beat: " + formatBeat(r.device_id),
          "Direction: " + formatDirection(r.direction),
          "Phone 1: " + (phone || "not mapped"),
          "Phone 2: " + (phone2 || "not mapped")
        ].join("\n");
      });

      let chunk = label + " | " + lines.length + " DEVICE(S)";
      for (const line of lines) {
        if ((chunk + "\n\n" + line).length > 3500) {
          await send(env, chat, chunk);
          chunk = label + " (continued)\n" + line;
        } else {
          chunk += "\n\n" + line;
        }
      }
      if (chunk) await send(env, chat, chunk);
      return;
    }

    if (c === "status" || c === "deviceinfo") {
      if (!ID(id)) {
        await send(env, chat, "Use /" + c + " DEVICE_ID");
        return;
      }

      const r = await db.prepare(`
        SELECT d.*,m.mobile,m.mobile2,m.person_name,
        t.end_time,t.end_ts,t.km_run,t.end_address,
        t.battery,t.gps_on,t.received_at,t.direction,t.direction_updated_at,
        t.history_km,t.history_checked_at
        FROM devices d
        LEFT JOIN mobile_map m ON m.device_id=d.device_id
        LEFT JOIN telemetry t ON t.device_id=d.device_id
        WHERE d.device_id=?
      `).bind(id).first();

      if (!r) {
        await send(env, chat, "Device not found.");
        return;
      }

      const age = r.end_ts
        ? Math.max(0, Math.round((Date.now() - r.end_ts) / 60000)) + " min ago"
        : "no GPS data";

      const phone = formatDialableMobile(r.mobile);
      const phone2 = formatDialableMobile(r.mobile2);
      let text =
        `${r.device_id} | ${r.section} ${r.patrol_no} | ${r.active ? "ACTIVE" : "INACTIVE"}
GPS: ${r.gps_on === null ? "unknown" : r.gps_on ? "ON" : "OFF"}
End: ${r.end_time || "No data"} (${age})
KM Run: ${formatKmRun(r.km_run, r.history_km)}
Address: ${r.end_address || "-"}
Battery: ${r.battery || "-"}
Beat: ${formatBeat(r.device_id)}
Direction: ${formatDirection(r.direction)}
Direction checked: ${r.direction_updated_at || "never"}
Phone 1: ${phone || "not mapped"}\nPhone 2: ${phone2 || "not mapped"}`;

      if (c === "deviceinfo") {
        const ignored = await db.prepare(
          "SELECT 1 FROM ignored_devices WHERE device_id=?"
        ).bind(id).first();

        text +=
          "\nName: " + (r.person_name || "-") +
          "\nFeed: " + (r.received_at || "never") +
          "\nIgnored: " + (ignored ? "YES" : "NO");
      }

      const phoneEntities = [];
      if (phone) phoneEntities.push({
        type: "phone_number",
        offset: text.indexOf("Phone 1: ") + "Phone 1: ".length,
        length: phone.length
      });
      if (phone2) phoneEntities.push({
        type: "phone_number",
        offset: text.indexOf("Phone 2: ") + "Phone 2: ".length,
        length: phone2.length
      });
      await send(env, chat, text, phoneEntities);
      return;
    }

    if (c === "pending") {
      const r = await db.prepare(`
        SELECT t.device_id,d.section,d.patrol_no,t.end_time
        FROM telemetry t
        JOIN devices d ON d.device_id=t.device_id
        LEFT JOIN ignored_devices i ON i.device_id=t.device_id
        WHERE d.active=1 AND i.device_id IS NULL
        AND (t.end_ts IS NULL OR t.end_ts<=?)
        ORDER BY t.end_ts LIMIT 50
      `).bind(Date.now() - (Number(await setting(db, "stale_minutes", "30")) || 30) * 60000).all();

      await send(env, chat,
        r.results.length
          ? r.results.map(x =>
              `${x.section} ${x.patrol_no} ${x.device_id} | ${x.end_time || "no data"}`
            ).join("\n")
          : "No stale devices."
      );

      return;
    }

    await send(env, chat, "Unknown command. /help");

  } catch (e) {
    console.error("command_failed", c, String(e));
    await send(env, chat, "Command failed: " + String(e).slice(0, 150));
  }
}

async function ingest(req, env, db) {
  if (!env.INGEST_SECRET) {
    return J({ ok: false, error: "INGEST_SECRET missing" }, 503);
  }

  if (req.headers.get("X-Ingest-Key") !== env.INGEST_SECRET) {
    return J({ ok: false, error: "Unauthorized" }, 401);
  }

  let b;

  try {
    b = await req.json();
  } catch {
    return J({ ok: false, error: "Invalid JSON" }, 400);
  }

  const rows = Array.isArray(b.rows) ? b.rows : [];

  if (!rows.length || rows.length > 500) {
    return J({ ok: false, error: "rows must contain 1..500" }, 400);
  }

  const q = [];

  for (const x of rows) {
    const d = S(x.device_id || x.deviceId);

    if (!ID(d)) {
      return J({ ok: false, error: "Invalid device_id" }, 400);
    }

    let ts = Number(x.end_ts || 0);

    if (ts && ts < 1e12) ts *= 1000;

    if (!ts && x.end_time) {
      const z = Date.parse(x.end_time);
      if (!Number.isNaN(z)) ts = z;
    }

    let gps = null;

    if (x.gps_on !== undefined && x.gps_on !== null) {
      const v = S(x.gps_on).toLowerCase();

      gps = ["1", "true", "on", "yes", "gps on"].includes(v)
        ? 1
        : ["0", "false", "off", "no", "gps off"].includes(v)
          ? 0
          : null;
    }

    q.push(
      db.prepare(`
        INSERT INTO telemetry(
          device_id,end_time,end_ts,km_run,
          end_address,battery,start_time,gps_on,
          payload,received_at
        )
        VALUES(?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(device_id) DO UPDATE SET
          end_time=excluded.end_time,
          end_ts=excluded.end_ts,
          km_run=excluded.km_run,
          end_address=excluded.end_address,
          battery=excluded.battery,
          start_time=excluded.start_time,
          gps_on=COALESCE(excluded.gps_on,telemetry.gps_on),
          payload=excluded.payload,
          received_at=CURRENT_TIMESTAMP
      `).bind(
        d,
        x.end_time || null,
        ts || null,
        x.km_run == null ? null : String(x.km_run),
        x.end_address || null,
        x.battery == null ? null : String(x.battery),
        x.start_time || null,
        gps,
        JSON.stringify(x)
      )
    );
  }

  await db.batch(q);
  await set(db, "last_ingest", new Date().toISOString());

  return J({ ok: true, received: rows.length });
}


function rilISTParts(date = new Date()) {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit",
    second: "2-digit", hourCycle: "h23"
  }).formatToParts(date).reduce((o, x) => (o[x.type] = x.value, o), {});
  return p;
}

function rilNightPeriod(date = new Date()) {
  const p = rilISTParts(date);
  const hour = Number(p.hour), minute = Number(p.minute);
  const active = hour > 22 || (hour === 22 && minute >= 30) ||
    hour < 7 || (hour === 7 && minute < 30);
  const endDate = p.day + "/" + p.month + "/" + p.year;
  const start = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)));
  start.setUTCDate(start.getUTCDate() - 1);
  const startDate = String(start.getUTCDate()).padStart(2, "0") + "/" +
    String(start.getUTCMonth() + 1).padStart(2, "0") + "/" + start.getUTCFullYear();
  return {
    active, startDate, endDate, endTime: p.hour + ":" + p.minute,
    label: startDate + " 22:30 – " + endDate + " " + p.hour + ":" + p.minute + " IST"
  };
}

function rilHtmlText(value) {
  return String(value || "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/(?:div|p|li)>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/\s+/g, " ").trim();
}

function rilReadAttributes(tag) {
  const attrs = {};
  for (const m of String(tag).matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    attrs[m[1].toLowerCase()] = rilHtmlText(m[2] ?? m[3] ?? m[4] ?? "");
  }
  return attrs;
}

function rilCookiesFromResponse(response, jar) {
  let cookies = [];
  if (typeof response.headers.getSetCookie === "function") {
    cookies = response.headers.getSetCookie();
  } else {
    const value = response.headers.get("set-cookie");
    if (value) cookies = [value];
  }
  for (const value of cookies) {
    const pair = String(value).split(";")[0].trim();
    const at = pair.indexOf("=");
    if (at > 0) jar.set(pair.slice(0, at), pair);
  }
}

async function rilRequest(url, init, jar) {
  let target = url;
  let method = (init && init.method) || "GET";
  let body = init && init.body;
  const baseHeaders = new Headers((init && init.headers) || {});
  for (let attempt = 0; attempt < 6; attempt++) {
    const headers = new Headers(baseHeaders);
    if (jar.size) headers.set("cookie", Array.from(jar.values()).join("; "));
    const response = await fetch(target, {
      method, body, headers, redirect: "manual", cf: { cacheTtl: 0, cacheEverything: false }
    });
    rilCookiesFromResponse(response, jar);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    target = new URL(location, target).toString();
    if (response.status === 303 ||
        ((response.status === 301 || response.status === 302) && method === "POST")) {
      method = "GET";
      body = undefined;
      baseHeaders.delete("content-type");
    }
  }
  throw new Error("RILAPP redirect limit exceeded");
}

function rilGetTable(html, id) {
  for (const match of String(html).matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)) {
    const opening = match[0].slice(0, match[0].indexOf(">") + 1);
    const attrs = rilReadAttributes(opening);
    if (attrs.id === id) return match[0];
  }
  return "";
}

function rilRowsFromTable(tableHtml) {
  const rows = [];
  for (const rowMatch of String(tableHtml).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const rawCells = [];
    const cells = [];
    for (const cellMatch of rowMatch[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)) {
      rawCells.push(cellMatch[1]);
      cells.push(rilHtmlText(cellMatch[1]));
    }
    if (cells.length) rows.push({ cells, raw: rowMatch[0], rawCells });
  }
  return rows;
}

function rilGetDeviceIdFromLinks(rawHtml) {
  for (const match of String(rawHtml).matchAll(/\bhref\s*=\s*["']([^"']*deviceid=[^"']*)["']/gi)) {
    try {
      const href = rilHtmlText(match[1]).replace(/&amp;/gi, "&");
      const id = new URL(href, "https://ip3.rilapp.com/railways/").searchParams.get("deviceid");
      if (id) return id.trim();
    } catch (_) {}
  }
  return "";
}

// Reuse the authenticated report row's original live-map URL.
function rilGetDeviceMapUrlFromRow(rawHtml) {
  let fallback = "";
  for (const match of String(rawHtml).matchAll(/<a\b[^>]*href\s*=\s*(?:"([^"]*deviceid=[^"]*)"|'([^']*deviceid=[^']*)')[^>]*>/gi)) {
    try {
      const href = rilHtmlText(match[1] ?? match[2]).replace(/&amp;/gi, "&");
      const url = new URL(href, "https://ip3.rilapp.com/railways/");
      if (url.origin !== "https://ip3.rilapp.com" || !url.searchParams.get("deviceid")) continue;
      if (/liveMapGoogle\.php/i.test(url.pathname)) return url.toString();
      if (!fallback) fallback = url.toString();
    } catch (_) {}
  }
  return fallback;
}

function rilExtractGpsId(deviceText, rawRow) {
  const match = String(deviceText || "").match(/(?:#|\()\s*(\d{4,})\b/);
  if (match) return match[1];
  return rilGetDeviceIdFromLinks(rawRow);
}

function rilParseDateTime(value, period) {
  const text = String(value || "").trim();
  const match = text.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (match) {
    const day = Number(match[1]), month = Number(match[2]), year = Number(match[3]);
    const hour = Number(match[4]), minute = Number(match[5]), second = Number(match[6] || 0);
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
    return Date.UTC(year, month - 1, day, hour, minute, second) - 330 * 60 * 1000;
  }
  const clock = text.match(/(?:^|\s)(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!clock || !period) return null;
  const hour = Number(clock[1]), minute = Number(clock[2]), second = Number(clock[3] || 0);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const date = hour < 7 || (hour === 7 && minute < 30) ? period.endDate : period.startDate;
  const parts = date.split("/").map(Number);
  return Date.UTC(parts[2], parts[1] - 1, parts[0], hour, minute, second) - 330 * 60 * 1000;
}

function rilParseBattery(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (/low\s*battery/i.test(text)) return "Low Battery";
  const match = text.match(/^(\d{1,3})(?:\s*%)?$/);
  if (!match) return null;
  const number = Number(match[1]);
  return number >= 0 && number <= 100 ? number + "%" : null;
}

function rilExtractBatteryForRow(row, batteryIndex) {
  const cells = row.cells;
  if (!cells.length) return null;
  if (batteryIndex >= 0 && cells[batteryIndex]) {
    const parsed = rilParseBattery(cells[batteryIndex]);
    if (parsed) return parsed;
  }
  for (let i = 0; i < cells.length - 1; i++) {
    if (/^\d{13,16}$/.test(cells[i])) {
      const parsed = rilParseBattery(cells[i + 1]);
      if (parsed) return parsed;
    }
  }
  for (const cell of cells) {
    const parsed = rilParseBattery(cell);
    if (parsed === "Low Battery") return parsed;
  }
  return null;
}

function rilParseBatteryPage(html) {
  const map = new Map();
  for (const tableMatch of String(html).matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)) {
    const table = tableMatch[0];
    const thead = /<thead\b[^>]*>([\s\S]*?)<\/thead>/i.exec(table);
    const headers = thead
      ? Array.from(thead[1].matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi), x => rilHtmlText(x[1]))
      : [];
    const batteryIndex = headers.findIndex(x => /battery|batt(?:ery)?\s*%/i.test(x));
    for (const row of rilRowsFromTable(table)) {
      if (!/liveMapGoogle\.php/i.test(row.raw) || !/deviceid=/i.test(row.raw)) continue;
      const linkMatch = row.raw.match(/<a\b[^>]*href=["'][^"']*deviceid=[^"']*["'][^>]*>([\s\S]*?)<\/a>/i);
      if (!linkMatch) continue;
      const gpsId = rilExtractGpsId(rilHtmlText(linkMatch[1]), row.raw);
      if (!/^\d{4,8}$/.test(gpsId)) continue;
      const battery = rilExtractBatteryForRow(row, batteryIndex);
      if (battery) map.set(gpsId, battery);
    }
  }
  return map;
}


const RIL_DIRECTION_LC_KM = new Map([
  [37, 71.45], [38, 73.05], [39, 74.75], [40, 77.15], [41, 79.15],
  [48, 91.25], [49, 93.35], [50, 95.75], [51, 97.85],
  [53, 105.3], [56, 109.5], [560, 110.2], [60, 115.4],
  [66, 129.4], [73, 141.35], [77, 149.45]
]);

function rilKmFromDirectionAddress(address) {
  const value = String(address || "").replace(/\s+/g, " ").trim();
  if (!value) return null;
  if (/LC[-\s]*56\s*\/\s*A/i.test(value)) return RIL_DIRECTION_LC_KM.get(560);
  const chainage = value.match(/(\d+)\s*\/\s*(\d+)/);
  if (chainage) {
    const km = Number(chainage[1]);
    const partText = chainage[2];
    const part = Number(partText);
    if (!Number.isFinite(km) || !Number.isFinite(part)) return null;
    return km + (partText.length === 1 ? part * 0.1 : part / 1000);
  }
  const lc = value.match(/LC[-\s.]*NO\.?\s*(\d+)|LC[-\s]*(\d+)/i);
  const lcNumber = lc ? Number(lc[1] || lc[2]) : null;
  return lcNumber !== null && Number.isFinite(lcNumber)
    ? (RIL_DIRECTION_LC_KM.get(lcNumber) ?? null) : null;
}

function rilNormalizeTrackTimestamp(value) {
  if (value == null || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric > 1e12 ? numeric : numeric * 1000;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function rilExtractHistoryPositions(html) {
  const match = String(html || "").match(/(?:var|let|const)\s+(?:poisitionsdata|positionsdata)\s*=\s*(\[[\s\S]*?\])\s*;/i);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1]);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function rilCalculateLatestDirection(html) {
  const positions = rilExtractHistoryPositions(html);
  const trend = [];
  for (const point of positions) {
    const km = rilKmFromDirectionAddress(point && point.address);
    const timestamp = rilNormalizeTrackTimestamp(point && point.timestamp);
    if (km !== null && timestamp !== null) trend.push({ km, timestamp });
  }
  trend.sort((a, b) => a.timestamp - b.timestamp);
  if (trend.length < 2) return null;
  // Match the supplied dashboard: ignore movement of 50 metres or less.
  for (let i = trend.length - 1; i > 0; i--) {
    const difference = trend[i].km - trend[i - 1].km;
    if (difference > 0.05) return "up";
    if (difference < -0.05) return "down";
  }
  return null;
}

async function rilRefreshDirections(db, latest, jar) {
  const current = await db.prepare("SELECT device_id,direction_updated_at FROM telemetry").all();
  const lastChecked = new Map(current.results.map(x => [
    String(x.device_id), Date.parse(String(x.direction_updated_at || "")) || 0
  ]));
  const now = Date.now();
  const tasks = Array.from(latest.values()).filter(item =>
    item.map_url && now - (lastChecked.get(String(item.device_id)) || 0) >= 55000
  );
  let next = 0, checked = 0, up = 0, down = 0, unknown = 0, failed = 0;
  const outcomes = [];
  const workers = Array.from({ length: Math.min(3, tasks.length) }, async () => {
    while (next < tasks.length) {
      const item = tasks[next++];
      try {
        const response = await rilRequest(item.map_url, {}, jar);
        const html = await response.text();
        if (!response.ok || /login\.php/i.test(response.url)) {
          throw new Error("GPS History session unavailable (HTTP " + response.status + ")");
        }
        const direction = rilCalculateLatestDirection(html);
        outcomes.push({ device_id: item.device_id, direction });
        checked++;
        if (direction === "up") up++;
        else if (direction === "down") down++;
        else unknown++;
      } catch (error) {
        failed++;
        console.warn("RILAPP GPS History failed for", item.device_id, String(error));
      }
    }
  });
  await Promise.all(workers);
  if (outcomes.length) {
    await db.batch(outcomes.map(x => db.prepare(
      "UPDATE telemetry SET direction=?,direction_updated_at=CURRENT_TIMESTAMP WHERE device_id=?"
    ).bind(x.direction, x.device_id)));
  }
  return { checked, up, down, unknown, failed };
}


function rilParseHistoryDistance(html) {
  const text = rilHtmlText(html);
  const match = text.match(/Distance\s*Travelled\s*:\s*([\d,]+(?:\.\d+)?)\s*KM/i);
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(value) ? value : null;
}

async function rilRefreshHistoryDistances(db, latest, period, jar) {
  const rows = await db.prepare("SELECT device_id,history_checked_at FROM telemetry").all();
  const checkedAt = new Map(rows.results.map(x => [
    String(x.device_id), Date.parse(String(x.history_checked_at || "")) || 0
  ]));
  const now = Date.now();
  const tasks = Array.from(latest.values()).filter(item =>
    now - (checkedAt.get(String(item.device_id)) || 0) >= 55000
  );
  let next = 0, checked = 0, discrepancies = 0, failed = 0, unavailable = 0;
  const updates = [];
  const api = "https://ip3.rilapp.com/railways/vehicleMapGoogleFilterNewAPI.php";
  const workers = Array.from({ length: Math.min(3, tasks.length) }, async () => {
    while (next < tasks.length) {
      const item = tasks[next++];
      try {
        const query = new URLSearchParams({
          deviceid: String(item.device_id),
          fdate: period.startDate,
          ftime: "23:00",
          tdate: period.endDate,
          ttime: period.endTime,
          Submit: "Update"
        });
        const response = await rilRequest(api + "?" + query.toString(), {}, jar);
        const html = await response.text();
        if (!response.ok || /login\.php/i.test(response.url) ||
            (/type=["']password["']/i.test(html) && /login|sign.?in/i.test(html))) {
          throw new Error("GPS History session unavailable (HTTP " + response.status + ")");
        }
        const distance = rilParseHistoryDistance(html);
        if (distance === null) {
          unavailable++;
          console.warn("History Distance label not found for", item.device_id);
          continue;
        }
        updates.push({ device_id: item.device_id, history_km: distance });
        checked++;
        const reportKm = parseKmValue(item.km_run);
        if (reportKm !== null && kmDifferenceMeters(reportKm, distance) >= 200) discrepancies++;
      } catch (error) {
        failed++;
        console.warn("RILAPP History Distance failed for", item.device_id, String(error));
      }
    }
  });
  await Promise.all(workers);
  if (updates.length) {
    await db.batch(updates.map(x => db.prepare(
      "UPDATE telemetry SET history_km=?,history_checked_at=CURRENT_TIMESTAMP WHERE device_id=?"
    ).bind(x.history_km, x.device_id)));
  }
  return { requested: tasks.length, checked, discrepancies, failed, unavailable };
}

async function runRilappFeed(env) {
  const period = rilNightPeriod();
  if (env.DB) await set(env.DB, "last_feed_attempt", new Date().toISOString());
  if (!env.RILAPP_USERNAME || !env.RILAPP_PASSWORD) {
    return { skipped: true, reason: "RILAPP_USERNAME/RILAPP_PASSWORD secrets missing" };
  }
  if (!env.DB) throw new Error("D1 DB binding missing");
  await init(env.DB);
  const historyPeriodKey = period.startDate + "|23:00|" + period.endDate;
  const previousHistoryPeriod = await setting(env.DB, "history_period", "");
  if (previousHistoryPeriod !== historyPeriodKey) {
    await env.DB.prepare("UPDATE telemetry SET history_km=NULL,history_checked_at=NULL").run();
    await set(env.DB, "history_period", historyPeriodKey);
  }
  const configured = await env.DB.prepare(
    "SELECT device_id FROM devices WHERE active=1"
  ).all();
  if (!configured.results.length) return { skipped: true, reason: "no active devices configured" };
  const knownIds = new Set(configured.results.map(x => String(x.device_id)));
  const jar = new Map();
  const base = "https://ip3.rilapp.com/railways/";
  const loginUrl = base + "login.php";
  const reportUrl = base + "patrollingReport.php";
  const batteryUrl = base + "dashboard_deviceListOnly.php";

  const login = await rilRequest(loginUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      username: env.RILAPP_USERNAME,
      password: env.RILAPP_PASSWORD
    }).toString()
  }, jar);
  const loginHtml = await login.text();
  if (!login.ok || (login.url.includes("login.php") && !/logout\.php/i.test(loginHtml))) {
    throw new Error("RILAPP login rejected (HTTP " + login.status + ")");
  }

  const query = new URLSearchParams({
    fdate: period.startDate,
    ftime: "23:00",
    tdate: period.endDate,
    ttime: period.endTime,
    Submit: "Update"
  });
  const report = await rilRequest(reportUrl + "?" + query.toString(), {}, jar);
  const reportHtml = await report.text();
  if (!report.ok || /login\.php/i.test(report.url) ||
      (/type=["']password["']/i.test(reportHtml) && /login|sign.?in/i.test(reportHtml))) {
    throw new Error("RILAPP report session unavailable (HTTP " + report.status + ")");
  }
  const reportTable = rilGetTable(reportHtml, "example");
  if (!reportTable) throw new Error("RILAPP report table #example not found");
  const allReportRows = rilRowsFromTable(reportTable);
  const headerRow = allReportRows[0];
  if (!headerRow) throw new Error("RILAPP report table has no rows");
  const headers = headerRow.cells.map(x => String(x).toLowerCase().replace(/[^a-z0-9]/g, ""));
  const findColumn = patterns => headers.findIndex(x => patterns.some(pattern => pattern.test(x)));
  let deviceIndex = findColumn([/^device$/]);
  let startIndex = findColumn([/^ontime$/, /^starttime$/]);
  let endIndex = findColumn([/^endtime$/]);
  let addressIndex = findColumn([/^endaddress$/]);
  let kmIndex = findColumn([/^kmrun$/, /^km$/]);
  const reportRows = allReportRows.slice(1);
  const firstDataRow = reportRows.find(row => row.cells.length >= 7);
  // RILAPP sometimes returns a grouped 18-column header but its actual body
  // uses the legacy 10-column layout: Section, Device, Start Time,
  // Start Address, End Time, End Address, KM Run, Overspeed, AvgSpeed,
  // Start Low Batt. In that response the header-derived indexes are invalid.
  if (firstDataRow && [deviceIndex, startIndex, endIndex, addressIndex, kmIndex]
      .some(index => index < 0 || index >= firstDataRow.cells.length)) {
    if (firstDataRow.cells.length >= 10) {
      deviceIndex = 1;
      startIndex = 2;
      endIndex = 4;
      addressIndex = 5;
      kmIndex = 6;
    }
  }
  if ([deviceIndex, startIndex, endIndex, addressIndex, kmIndex].some(x => x < 0)) {
    throw new Error("RILAPP report columns not recognized: " + headerRow.cells.join(" | "));
  }
  const latest = new Map();
  let rowsSeen = 0, idMatched = 0, timeParsed = 0;
  const sampleDevices = [];
  for (const row of reportRows) {
    const c = row.cells;
    if (c.length <= Math.max(deviceIndex, startIndex, endIndex, addressIndex, kmIndex)) continue;
    rowsSeen++;
    const deviceText = c[deviceIndex] || "";
    const gpsId = rilExtractGpsId(deviceText, row.raw);
    if (sampleDevices.length < 12) sampleDevices.push(deviceText + " => " + (gpsId || "NO_ID"));
    if (!knownIds.has(gpsId)) continue;
    idMatched++;
    const endTs = rilParseDateTime(c[endIndex], period);
    if (!endTs) continue;
    timeParsed++;
    const old = latest.get(gpsId);
    if (!old || endTs > old.end_ts) {
      latest.set(gpsId, {
        device_id: gpsId,
        start_time: c[startIndex] || null,
        end_time: c[endIndex] || null,
        end_ts: endTs,
        end_address: c[addressIndex] || null,
        km_run: c[kmIndex] || null,
        map_url: rilGetDeviceMapUrlFromRow(row.raw) || (old && old.map_url) || ""
      });
    }
  }
  if (!latest.size) {
    throw new Error(
      "RILAPP parser diagnostic: rows=" + rowsSeen +
      ", IDs matched active devices=" + idMatched +
      ", valid End Times=" + timeParsed +
      ", headers=" + headers.join("|") +
      ", tableHTMLchars=" + reportTable.length +
      ", reportHTMLchars=" + reportHtml.length +
      ", scriptRefs=" + Array.from(reportHtml.matchAll(/<script\b[^>]*src=["']([^"']+)["']/gi), m => m[1]).slice(0, 12).join(";") +
      ", dataTableConfig=" + Array.from(reportHtml.matchAll(/.{0,180}(?:DataTable|dataTable|sAjaxSource|ajax\s*:|serverSide|processing\s*:).{0,260}/gi), m => m[0].replace(/\s+/g, " ")).slice(0, 8).join(" || ").slice(0, 1600) +
      ", ajaxHints=" + Array.from(reportHtml.matchAll(/.{0,100}(?:ajax|serverSide|dataSrc|fetch\s*\(|XMLHttpRequest).{0,180}/gi), m => m[0].replace(/\s+/g, " ")).slice(0, 8).join(" || ").slice(0, 800) +
      ", knownIdsInHTML=" + Array.from(knownIds).filter(id => reportHtml.includes(id)).slice(0, 20).join(",") +
      ", sample=" + sampleDevices.join("; ").slice(0, 500)
    );
  }

  const batteryResponse = await rilRequest(batteryUrl, {}, jar);
  if (!batteryResponse.ok) throw new Error("RILAPP battery page HTTP " + batteryResponse.status);
  const batteryMap = rilParseBatteryPage(await batteryResponse.text());
  for (const [id, item] of latest) {
    if (batteryMap.has(id)) item.battery = batteryMap.get(id);
  }

  const sql = "INSERT INTO telemetry(device_id,end_time,end_ts,km_run,end_address,battery,start_time,payload,received_at) " +
    "VALUES(?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP) " +
    "ON CONFLICT(device_id) DO UPDATE SET " +
    "end_time=COALESCE(excluded.end_time,telemetry.end_time)," +
    "end_ts=COALESCE(excluded.end_ts,telemetry.end_ts)," +
    "km_run=COALESCE(excluded.km_run,telemetry.km_run)," +
    "end_address=COALESCE(excluded.end_address,telemetry.end_address)," +
    "battery=COALESCE(excluded.battery,telemetry.battery)," +
    "start_time=COALESCE(excluded.start_time,telemetry.start_time)," +
    "payload=excluded.payload,received_at=CURRENT_TIMESTAMP";
  const statements = Array.from(latest.values(), item =>
    env.DB.prepare(sql).bind(
      item.device_id, item.end_time, item.end_ts, item.km_run,
      item.end_address, item.battery || null, item.start_time,
      JSON.stringify({ ...item, window: period.label, battery_matches: batteryMap.size })
    )
  );
  await env.DB.batch(statements);
  const directionStats = await rilRefreshDirections(env.DB, latest, jar);
  const historyStats = await rilRefreshHistoryDistances(env.DB, latest, period, jar);
  await set(env.DB, "last_history_checked", String(historyStats.checked));
  await set(env.DB, "last_history_discrepancies", String(historyStats.discrepancies));
  await set(env.DB, "last_history_failed", String(historyStats.failed));
  await set(env.DB, "last_direction_checked", String(directionStats.checked));
  await set(env.DB, "last_direction_failures", String(directionStats.failed));
  await set(env.DB, "last_ingest", new Date().toISOString());
  await set(env.DB, "last_feed_error", "");
  await set(env.DB, "last_rilapp_rows", String(latest.size));
  await set(env.DB, "last_rilapp_batteries", String(batteryMap.size));
  return { ok: true, rows: latest.size, batteries: batteryMap.size, directions: directionStats, history: historyStats, window: period.label };
}

async function tick(env) {
  if (!env.DB) throw Error("DB binding missing");

  await init(env.DB);


  if (await setting(env.DB, "monitor", "off") !== "on" ||
      !env.TELEGRAM_BOT_TOKEN) return;

  const now = Date.now();
  const staleMinutes = Number(await setting(env.DB, "stale_minutes", "30")) || 30;
  const staleMs = staleMinutes * 60000;
  const chat = env.TELEGRAM_ALERT_CHAT_ID || env.TELEGRAM_ADMIN_ID;

  if (!chat) return;

  const snapshot = await env.DB.prepare(`
    SELECT d.device_id,d.section,d.patrol_no,t.end_time,t.end_ts,t.gps_on
    FROM devices d
    LEFT JOIN telemetry t ON t.device_id=d.device_id
    LEFT JOIN ignored_devices i ON i.device_id=d.device_id
    WHERE d.active=1 AND i.device_id IS NULL
    ORDER BY d.section,d.patrol_no
  `).all();

  const staleDevices = snapshot.results.filter(x =>
    !x.end_ts || Number(x.end_ts) < now - staleMs
  );

  if (snapshot.results.length > 0 && staleDevices.length === 0) {
    await send(env, chat,
      "\u2705 ALL IS WELL\n" +
      "All " + snapshot.results.length +
      " active devices updated within the last " + staleMinutes + " minutes."
    );
  } else if (snapshot.results.length === 0) {
    await send(env, chat, "NO ACTIVE DEVICES CONFIGURED");
  } else {
    const old = await env.DB.prepare(
      "SELECT d.device_id,d.section,d.patrol_no," +
      "t.start_time,t.end_time,t.end_ts,t.km_run,t.history_km,t.end_address," +
      "t.battery,t.gps_on,t.last_alert_at,m.mobile,m.mobile2,m.person_name " +
      "FROM devices d " +
      "LEFT JOIN telemetry t ON t.device_id=d.device_id " +
      "LEFT JOIN ignored_devices i ON i.device_id=d.device_id " +
      "LEFT JOIN mobile_map m ON m.device_id=d.device_id " +
      "WHERE d.active=1 AND i.device_id IS NULL " +
      "AND (t.end_ts IS NULL OR t.end_ts < ?) " +
      "AND (t.last_alert_at IS NULL OR t.last_alert_at <= ?) " +
      "ORDER BY CASE d.section WHEN 'RJK' THEN 1 WHEN 'RG' THEN 2 " +
      "WHEN 'CH' THEN 3 ELSE 4 END,d.patrol_no LIMIT 70"
    ).bind(now - staleMs, now - REPEAT).all();

    if (old.results.length) {
      const staleLines = ["\u26a0\ufe0f GPS UPDATE OLDER THAN " + staleMinutes + " MINUTES"];
      const staleEntities = [];

      for (const section of ["RJK", "RG", "CH"]) {
        const items = old.results.filter(x => x.section === section);
        if (!items.length) continue;
        staleLines.push("", section);

        for (const x of items) {
          const phone = formatDialableMobile(x.mobile);
          const phone2 = formatDialableMobile(x.mobile2);
          const age = x.end_ts
            ? Math.floor((now - Number(x.end_ts)) / 60000) + " minutes"
            : "No GPS data";
          const details = [
            "\u26a0\ufe0f " + x.patrol_no + " | GPS ID: " + x.device_id,
            "Name: " + (x.person_name || "Not mapped"),
            "Start Time: " + (x.start_time || "-"),
            "Last Update: " + (x.end_time || "No data") + " (" + age + ")",
            "KM Run: " + formatKmRun(x.km_run, x.history_km),
            "Address: " + (x.end_address || "-"),
            "Battery: " + (x.battery || "-"),
            "GPS: " + (x.gps_on === 0 ? "OFF" : x.gps_on === 1 ? "ON" : "Unknown"),
            "Call 1: " + (phone || "Not mapped"),
            "Call 2: " + (phone2 || "Not mapped")
          ];

          for (const line of details) {
            const prefix = line.startsWith("Call 1: ") ? "Call 1: " :
              line.startsWith("Call 2: ") ? "Call 2: " : "";
            const value = prefix ? line.slice(prefix.length) : "";
            if (prefix && value.startsWith("+")) {
              staleEntities.push({
                type: "phone_number",
                offset: staleLines.join("\n").length + 1 + prefix.length,
                length: value.length
              });
            }
            staleLines.push(line);
          }
          staleLines.push("");
        }
      }

      const ok = await send(
        env, chat, staleLines.join("\n").trim(), staleEntities
      );
      if (ok) {
        await env.DB.batch(old.results.map(x =>
          env.DB.prepare(
            "UPDATE telemetry SET last_alert_at=? WHERE device_id=?"
          ).bind(now, x.device_id)
        ));
      }
    }
  }

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(now));

  const get = k => parts.find(x => x.type === k)?.value;

  const hh = Number(get("hour"));
  const mm = Number(get("minute"));

  const today = get("year") + "-" + get("month") + "-" + get("day");

  const night =
    hh > 22 || (hh === 22 && mm >= 30) || hh < 7 || (hh === 7 && mm < 30);

  {
    const off = await env.DB.prepare(`
      SELECT t.device_id,d.section,d.patrol_no,
      t.last_night_alert_at,m.mobile,m.mobile2
      FROM telemetry t
      JOIN devices d ON d.device_id=t.device_id
      LEFT JOIN ignored_devices i ON i.device_id=t.device_id
      LEFT JOIN mobile_map m ON m.device_id=t.device_id
      WHERE d.active=1 AND i.device_id IS NULL
      AND t.gps_on=0
      AND (t.last_night_alert_at IS NULL OR t.last_night_alert_at<=?)
      ORDER BY d.section,d.patrol_no LIMIT 70
    `).bind(now - REPEAT).all();

    if (off.results.length) {
      const offLines = ["⚠️ GPS OFF ALERT"];
      const offEntities = [];
      for (const x of off.results) {
        const phone = formatDialableMobile(x.mobile);
        const phone2 = formatDialableMobile(x.mobile2);
        const line = x.section + " " + x.patrol_no + " | " + x.device_id +
          " | Phone 1: " + (phone || "not mapped") +
          " | Phone 2: " + (phone2 || "not mapped");
        const base = offLines.join("\n").length + 1;
        offLines.push(line);
        if (phone) offEntities.push({
          type: "phone_number",
          offset: base + line.indexOf("Phone 1: ") + "Phone 1: ".length,
          length: phone.length
        });
        if (phone2) offEntities.push({
          type: "phone_number",
          offset: base + line.indexOf("Phone 2: ") + "Phone 2: ".length,
          length: phone2.length
        });
      }
      const ok = await send(env, chat, offLines.join("\n"), offEntities);

      if (ok) {
        await env.DB.batch(off.results.map(x =>
          env.DB.prepare(
            "UPDATE telemetry SET last_night_alert_at=? WHERE device_id=?"
          ).bind(now, x.device_id)
        ));
      }
    }
  }

  if (hh === 23 && mm >= 25 && mm < 30 &&
      await setting(env.DB, "night_report_date", "") !== today) {

    const off = await env.DB.prepare(`
      SELECT d.section,d.patrol_no,d.device_id
      FROM devices d
      LEFT JOIN telemetry t ON t.device_id=d.device_id
      LEFT JOIN ignored_devices i ON i.device_id=d.device_id
      WHERE d.active=1 AND i.device_id IS NULL
      AND t.gps_on=0
      ORDER BY d.section,d.patrol_no
    `).all();

    const ok = await send(env, chat,
      "23:25 NIGHT GPS REPORT (" + today + ")\n" +
      (off.results.length
        ? off.results.map(x =>
            `${x.section} ${x.patrol_no} | ${x.device_id}`
          ).join("\n")
        : "No known GPS-OFF devices.")
    );

    if (ok) {
      await set(env.DB, "night_report_date", today);
    }
  }
}

export default {
  async fetch(req, env, ctx) {
    const u = new URL(req.url);

    if (u.pathname === "/" && req.method === "GET") {
      return J({
        name: "Railway GPS Telegram Controller",
        version: "1.0.0",
        endpoints: ["/health", "/telegram/webhook", "/ingest"]
      });
    }

    if (u.pathname === "/health" && req.method === "GET") {
      try {
        if (!env.DB) {
          return J({
            ok: false,
            worker: "online",
            database: "missing DB"
          }, 503);
        }

        await init(env.DB);

        const n = await env.DB.prepare(
          "SELECT COUNT(*) n FROM devices WHERE active=1"
        ).first();

        return J({
          ok: true,
          worker: "online",
          database: "connected",
          active_devices: n.n,
          monitor: await setting(env.DB, "monitor", "off"),
          telegram_token: !!env.TELEGRAM_BOT_TOKEN,
          admin_configured: !!env.TELEGRAM_ADMIN_ID,
          ingest_secret: !!env.INGEST_SECRET,
          webhook_secret: !!env.TELEGRAM_WEBHOOK_SECRET,
          integration_version: "rilapp-night-feed-v1",
          rilapp_configured: !!(env.RILAPP_USERNAME && env.RILAPP_PASSWORD),
          last_rilapp_rows: await setting(env.DB, "last_rilapp_rows", "never"),
          last_rilapp_batteries: await setting(env.DB, "last_rilapp_batteries", "never")
        });

      } catch (e) {
        return J({ ok: false, error: String(e) }, 500);
      }
    }

    if (!env.DB) {
      return J({ ok: false, error: "D1 DB binding missing" }, 503);
    }

    try {
      await init(env.DB);
    } catch (e) {
      return J({
        ok: false,
        error: "D1 init failed: " + String(e)
      }, 500);
    }

    if (u.pathname === "/ingest" && req.method === "POST") {
      return ingest(req, env, env.DB);
    }

    if (u.pathname === "/admin/register-webhook" && req.method === "POST") {
      if (!env.TELEGRAM_WEBHOOK_SECRET ||
          req.headers.get("X-Webhook-Setup-Key") !== env.TELEGRAM_WEBHOOK_SECRET) {
        return J({ ok: false, error: "Unauthorized" }, 401);
      }
      if (!env.TELEGRAM_BOT_TOKEN) return J({ ok: false, error: "Bot token missing" }, 503);
      if (await setting(env.DB, "webhook_registered", "off") === "on") {
        return J({ ok: false, error: "Already registered" }, 410);
      }
      const webhookUrl = new URL("/telegram/webhook", u.origin).toString();
      const telegram = await fetch("https://api.telegram.org/bot" +
        env.TELEGRAM_BOT_TOKEN + "/setWebhook", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            url: webhookUrl,
            secret_token: env.TELEGRAM_WEBHOOK_SECRET,
            allowed_updates: ["message", "edited_message", "callback_query"],
            drop_pending_updates: false
          })
        });
      const result = await telegram.json();
      if (result.ok) await set(env.DB, "webhook_registered", "on");
      return J({ ok: !!result.ok, webhook_url: webhookUrl, telegram: result },
        result.ok ? 200 : 502);
    }

    if (u.pathname === "/telegram/webhook" && req.method === "POST") {
      if (!env.TELEGRAM_WEBHOOK_SECRET ||
          req.headers.get("X-Telegram-Bot-Api-Secret-Token") !==
          env.TELEGRAM_WEBHOOK_SECRET) {
        return J({ ok: false, error: "Unauthorized" }, 401);
      }

      let update;

      try {
        update = await req.json();
      } catch {
        return J({ ok: false, error: "Invalid Telegram update" }, 400);
      }

      const msg = update.message || update.edited_message;
      if (msg) ctx.waitUntil(cmd(env, env.DB, msg));
      if (update.callback_query) ctx.waitUntil(handleGpsCallback(env, env.DB, update.callback_query));

      return J({ ok: true });
    }

    return J({ ok: false, error: "Not found" }, 404);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try {
        const result = await runRilappFeed(env);
        if (result && result.ok) console.log('RILAPP feed updated', result.rows, 'rows; batteries:', result.batteries);
      } catch (error) {
        const message = String(error && error.message ? error.message : error).slice(0, 700);
        try { await set(env.DB, "last_feed_error", message); } catch (_) {}
        console.error('RILAPP feed failed:', message);
      }
      try { await tick(env); }
      catch (error) { console.error('GPS alert tick failed:', error && error.message ? error.message : String(error)); }
    })());
  }
};