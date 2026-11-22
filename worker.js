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

async function init(db) {
  for (const q of SQL) {
    await db.prepare(q).run();
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

function formatDialableMobile(value) {
  const raw = String(value || "").trim();
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return "+91" + digits;
  if (digits.length === 11 && digits.startsWith("0")) return "+91" + digits.slice(1);
  if (digits.length === 12 && digits.startsWith("91")) return "+" + digits;
  if (raw.startsWith("+") && digits.length >= 8 && digits.length <= 15) return "+" + digits;
  return "";
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
  const line = full.split("\n", 1)[0];

  const m = line.match(
    /^\/(\w+)(?:@\w+)?(?:\s+(.*))?$/
  );

  if (!m) return;

  const c = m[1].toLowerCase();
  const a = m[2] || "";
  const p = a.trim() ? a.trim().split(/\s+/) : [];
  const id = p[0] || "";

  try {

    if (c === "start" || c === "help") {
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
/mapmobile
/mobile ID
/unmapmobile ID
/status ID
/deviceinfo ID
/monitor on|off
/stale [MINUTES]
/pending
/health
/sync (manual RILAPP refresh)`);
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
              typeof v === "string"
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
          const phone = S(x.mobile || x.phone).replace(/[\s+-]/g, "");

          if (!ID(d) || !/^\d{10,15}$/.test(phone)) {
            await send(env, chat, "Invalid mobile mapping JSON.");
            return;
          }

          rows.push({
            d,
            phone,
            name: S(x.name || x.person_name)
          });
        }

        await db.batch(rows.map(x =>
          db.prepare(`
            INSERT INTO mobile_map(device_id,mobile,person_name,updated_at)
            VALUES(?,?,?,CURRENT_TIMESTAMP)
            ON CONFLICT(device_id) DO UPDATE SET
            mobile=excluded.mobile,
            person_name=excluded.person_name,
            updated_at=CURRENT_TIMESTAMP
          `).bind(x.d, x.phone, x.name)
        ));

        await send(env, chat,
          "Mobile mappings saved: " + rows.length + "\n" +
          rows.map(x => x.d + " -> " + MASK(x.phone)).join("\n")
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
        "SELECT mobile,person_name FROM mobile_map WHERE device_id=?"
      ).bind(id).first();

      await send(env, chat,
        r
          ? id + " -> " + MASK(r.mobile) +
            (r.person_name ? " (" + r.person_name + ")" : "")
          : "No mobile mapped."
      );

      return;
    }

    if (c === "status" || c === "deviceinfo") {
      if (!ID(id)) {
        await send(env, chat, "Use /" + c + " DEVICE_ID");
        return;
      }

      const r = await db.prepare(`
        SELECT d.*,m.mobile,m.person_name,
        t.end_time,t.end_ts,t.km_run,t.end_address,
        t.battery,t.gps_on,t.received_at
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
      let text =
        `${r.device_id} | ${r.section} ${r.patrol_no} | ${r.active ? "ACTIVE" : "INACTIVE"}
GPS: ${r.gps_on === null ? "unknown" : r.gps_on ? "ON" : "OFF"}
End: ${r.end_time || "No data"} (${age})
KM: ${r.km_run || "-"}
Address: ${r.end_address || "-"}
Battery: ${r.battery || "-"}
Phone: ${phone || "not mapped"}`;

      if (c === "deviceinfo") {
        const ignored = await db.prepare(
          "SELECT 1 FROM ignored_devices WHERE device_id=?"
        ).bind(id).first();

        text +=
          "\nName: " + (r.person_name || "-") +
          "\nFeed: " + (r.received_at || "never") +
          "\nIgnored: " + (ignored ? "YES" : "NO");
      }

      const phoneOffset = phone ? text.indexOf("Phone: ") + "Phone: ".length : -1;
      await send(env, chat, text, phone ? [{
        type: "phone_number",
        offset: phoneOffset,
        length: phone.length
      }] : []);
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

async function runRilappFeed(env) {
  const period = rilNightPeriod();
  if (env.DB) await set(env.DB, "last_feed_attempt", new Date().toISOString());
  if (!env.RILAPP_USERNAME || !env.RILAPP_PASSWORD) {
    return { skipped: true, reason: "RILAPP_USERNAME/RILAPP_PASSWORD secrets missing" };
  }
  if (!env.DB) throw new Error("D1 DB binding missing");
  await init(env.DB);
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
  const deviceIndex = findColumn([/^device$/]);
  const startIndex = findColumn([/^ontime$/, /^starttime$/]);
  const endIndex = findColumn([/^endtime$/]);
  const addressIndex = findColumn([/^endaddress$/]);
  const kmIndex = findColumn([/^kmrun$/, /^km$/]);
  if ([deviceIndex, startIndex, endIndex, addressIndex, kmIndex].some(x => x < 0)) {
    throw new Error("RILAPP report columns not recognized: " + headerRow.cells.join(" | "));
  }
  const reportRows = allReportRows.slice(1);
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
        km_run: c[kmIndex] || null
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
  await set(env.DB, "last_ingest", new Date().toISOString());
  await set(env.DB, "last_feed_error", "");
  await set(env.DB, "last_rilapp_rows", String(latest.size));
  await set(env.DB, "last_rilapp_batteries", String(batteryMap.size));
  return { ok: true, rows: latest.size, batteries: batteryMap.size, window: period.label };
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
      "t.start_time,t.end_time,t.end_ts,t.km_run,t.end_address," +
      "t.battery,t.gps_on,t.last_alert_at,m.mobile,m.person_name " +
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
          const age = x.end_ts
            ? Math.floor((now - Number(x.end_ts)) / 60000) + " minutes"
            : "No GPS data";
          const details = [
            "\u26a0\ufe0f " + x.patrol_no + " | GPS ID: " + x.device_id,
            "Name: " + (x.person_name || "Not mapped"),
            "Start Time: " + (x.start_time || "-"),
            "Last Update: " + (x.end_time || "No data") + " (" + age + ")",
            "KM Run: " + (x.km_run || "-"),
            "Address: " + (x.end_address || "-"),
            "Battery: " + (x.battery || "-"),
            "GPS: " + (x.gps_on === 0 ? "OFF" : x.gps_on === 1 ? "ON" : "Unknown"),
            "Call: " + (phone || "Not mapped")
          ];

          for (const line of details) {
            if (phone && line === "Call: " + phone) {
              const offset = staleLines.join("\n").length + 1 + "Call: ".length;
              staleEntities.push({
                type: "phone_number",
                offset,
                length: phone.length
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
      t.last_night_alert_at,m.mobile
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
        const line = x.section + " " + x.patrol_no + " | " + x.device_id + " | Phone: " + (phone || "not mapped");
        const offset = offLines.join("\n").length + 1 + line.lastIndexOf(phone);
        offLines.push(line);
        if (phone) offEntities.push({ type: "phone_number", offset, length: phone.length });
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
            allowed_updates: ["message", "edited_message"],
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
