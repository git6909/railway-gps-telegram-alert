const STALE = 1800000;
const REPEAT = 1800000;

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

async function send(env, chat, text) {
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
/adddevice SECTION P# ID
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
/pending
/health`);
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
Last feed: ${await setting(db, "last_ingest", "never")}`);

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

    if (c === "adddevice") {
      const [s, pat, d] = p;

      if (!SEC(s) ||
          !/^P\d{1,2}$/i.test(pat || "") ||
          !ID(d)) {
        await send(env, chat,
          "Format: /adddevice RJK P11 88336");
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
        "Device not found; use /adddevice."
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

      let text =
        `${r.device_id} | ${r.section} ${r.patrol_no} | ${r.active ? "ACTIVE" : "INACTIVE"}
GPS: ${r.gps_on === null ? "unknown" : r.gps_on ? "ON" : "OFF"}
End: ${r.end_time || "No data"} (${age})
KM: ${r.km_run || "-"}
Address: ${r.end_address || "-"}
Battery: ${r.battery || "-"}
Phone: ${r.mobile ? MASK(r.mobile) : "not mapped"}`;

      if (c === "deviceinfo") {
        const ignored = await db.prepare(
          "SELECT 1 FROM ignored_devices WHERE device_id=?"
        ).bind(id).first();

        text +=
          "\nName: " + (r.person_name || "-") +
          "\nFeed: " + (r.received_at || "never") +
          "\nIgnored: " + (ignored ? "YES" : "NO");
      }

      await send(env, chat, text);
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
      `).bind(Date.now() - STALE).all();

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

async function tick(env) {
  if (!env.DB) throw Error("DB binding missing");

  await init(env.DB);

  if (await setting(env.DB, "monitor", "off") !== "on" ||
      !env.TELEGRAM_BOT_TOKEN) return;

  const now = Date.now();
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

  const staleCount = snapshot.results.filter(x =>
    !x.end_ts || x.end_ts <= now - STALE
  ).length;
  const freshCount = snapshot.results.length - staleCount;
  const summary = [
    "RAILWAY GPS LIVE STATUS",
    "Updated: " + new Date(now).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
    "Devices: " + snapshot.results.length + " | Live: " + freshCount + " | Stale/No data: " + staleCount,
    "",
    ...snapshot.results.map(x => {
      const stale = !x.end_ts || x.end_ts <= now - STALE;
      const age = x.end_ts
        ? Math.max(0, Math.floor((now - x.end_ts) / 60000)) + "m"
        : "no data";
      const gps = x.gps_on === 0 ? " GPS-OFF" : "";
      return (stale ? "⚠️" : "🟢") + " " + x.section + " " + x.patrol_no +
        " | " + x.device_id + " | " + age + gps;
    })
  ].join("\\n");

  await send(env, chat, summary);

  const old = await env.DB.prepare(`
    SELECT t.device_id,d.section,d.patrol_no,
    t.end_time,t.last_alert_at,m.mobile
    FROM telemetry t
    JOIN devices d ON d.device_id=t.device_id
    LEFT JOIN ignored_devices i ON i.device_id=t.device_id
    LEFT JOIN mobile_map m ON m.device_id=t.device_id
    WHERE d.active=1 AND i.device_id IS NULL
    AND (t.end_ts IS NULL OR t.end_ts<=?)
    AND (t.last_alert_at IS NULL OR t.last_alert_at<=?)
    ORDER BY t.end_ts LIMIT 70
  `).bind(now - STALE, now - REPEAT).all();

  if (old.results.length) {
    const ok = await send(env, chat,
      "GPS STALE ALERT (30+ min/no data)\n" +
      old.results.map(x =>
        `${x.section} ${x.patrol_no} | ${x.device_id}
End: ${x.end_time || "no data"} | Phone: ${x.mobile ? MASK(x.mobile) : "not mapped"}`
      ).join("\n")
    );

    if (ok) {
      await env.DB.batch(old.results.map(x =>
        env.DB.prepare(
          "UPDATE telemetry SET last_alert_at=? WHERE device_id=?"
        ).bind(now, x.device_id)
      ));
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
    hh >= 23 || hh < 7 || (hh === 7 && mm <= 15);

  if (night) {
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
      const ok = await send(env, chat,
        "NIGHT GPS OFF ALERT\n" +
        off.results.map(x =>
          `${x.section} ${x.patrol_no} | ${x.device_id} | ${x.mobile ? MASK(x.mobile) : "no mobile mapping"}`
        ).join("\n")
      );

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
          webhook_secret: !!env.TELEGRAM_WEBHOOK_SECRET
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
    ctx.waitUntil(tick(env));
  }
};
