"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name2 in all)
    __defProp(target, name2, { get: all[name2], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/functions/payroll-run.ts
var payroll_run_exports = {};
__export(payroll_run_exports, {
  handler: () => handler
});
module.exports = __toCommonJS(payroll_run_exports);

// src/lib/dates.ts
var DAY_MS = 864e5;
var ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
function toUtc(d) {
  const m = ISO_RE.exec(d);
  if (!m) throw new Error(`Invalid date: ${d}`);
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (fromUtc(t) !== d) throw new Error(`Invalid date: ${d}`);
  return t;
}
function fromUtc(t) {
  return new Date(t).toISOString().slice(0, 10);
}
function addDays(d, n) {
  return fromUtc(toUtc(d) + n * DAY_MS);
}
function dayOfWeek(d) {
  return new Date(toUtc(d)).getUTCDay();
}
function isWeekday(d) {
  const w = dayOfWeek(d);
  return w !== 0 && w !== 6;
}
function eachDay(start, end) {
  const out = [];
  for (let t = toUtc(start), last = toUtc(end); t <= last; t += DAY_MS) out.push(fromUtc(t));
  return out;
}
function weekStart(d, startsOn) {
  return addDays(d, -((dayOfWeek(d) - startsOn + 7) % 7));
}
function monthBounds(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error(`Invalid month: ${month}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) throw new Error(`Invalid month: ${month}`);
  return { start: fromUtc(Date.UTC(y, mo - 1, 1)), end: fromUtc(Date.UTC(y, mo, 0)) };
}
var maxDate = (a, b) => a > b ? a : b;
var minDate = (a, b) => a < b ? a : b;

// src/lib/money.ts
function divRoundHalfUp(n, d) {
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(d) || d <= 0) {
    throw new Error(`divRoundHalfUp needs safe integers and d > 0 (got ${n}/${d})`);
  }
  if (n < 0) return -divRoundHalfUp(-n, d);
  let q = Math.floor(n / d);
  let r = n - q * d;
  while (r < 0) {
    q -= 1;
    r += d;
  }
  while (r >= d) {
    q += 1;
    r -= d;
  }
  return 2 * r >= d ? q + 1 : q;
}
var toHundredths = (x) => Math.round(x * 100);
var toTenths = (x) => Math.round(x * 10);
var toThousandths = (x) => Math.round(x * 1e3);

// src/lib/pay-calc/lines.ts
var add = (a, b) => (a ?? 0) + b;
var LineAccumulator = class {
  constructor(emp) {
    this.emp = emp;
  }
  emp;
  buckets = /* @__PURE__ */ new Map();
  fixed = [];
  bucket(code, payType, rate, m1000) {
    const key = `${code}|${payType}|${rate}|${m1000}`;
    let b = this.buckets.get(key);
    if (!b) {
      b = { code, payType, rate, m1000, h100: null, d10: null };
      this.buckets.set(key, b);
    }
    return b;
  }
  /** Paid hours: amount = hours × rate × multiplier. */
  addHours(code, payType, rate, m1000, h100) {
    if (h100 <= 0) return;
    const b = this.bucket(code, payType, rate, m1000);
    b.h100 = add(b.h100, h100);
  }
  /** Paid days: amount = days × rate. Hours, if entered, are reported but not paid. */
  addDays(code, payType, rate, d10, h100 = 0) {
    if (d10 <= 0) return;
    const b = this.bucket(code, payType, rate, 1e3);
    b.d10 = add(b.d10, d10);
    if (h100 > 0) b.h100 = add(b.h100, h100);
  }
  /** Quantity reported with no pay (e.g. PTO hours for a salaried employee). */
  addInfo(code, payType, h100, d10) {
    if (h100 <= 0 && d10 <= 0) return;
    const b = this.bucket(code, payType, 0, 0);
    if (h100 > 0) b.h100 = add(b.h100, h100);
    if (d10 > 0) b.d10 = add(b.d10, d10);
  }
  /** A line whose amount the caller computed (salary segment, day-rate OT premium). */
  addFixed(line) {
    this.fixed.push(line);
  }
  lines() {
    const base = {
      employee_id: this.emp.id,
      external_id: this.emp.external_id,
      first_name: this.emp.first_name,
      last_name: this.emp.last_name,
      email: this.emp.email,
      work_state: this.emp.work_state
    };
    const out = [];
    for (const f of this.fixed) {
      out.push({
        ...base,
        pay_type: f.payType,
        earning_code: f.code,
        hours: f.h100 == null ? null : f.h100 / 100,
        days: f.d10 == null ? null : f.d10 / 10,
        rate_cents: f.rate,
        amount_cents: f.amount
      });
    }
    for (const b of this.buckets.values()) {
      let amount = 0;
      let rate = 0;
      if (b.m1000 > 0 && b.d10 != null) {
        amount = divRoundHalfUp(b.d10 * b.rate, 10);
        rate = b.rate;
      } else if (b.m1000 > 0 && b.h100 != null) {
        amount = divRoundHalfUp(b.h100 * b.rate * b.m1000, 1e5);
        rate = divRoundHalfUp(b.rate * b.m1000, 1e3);
      }
      out.push({
        ...base,
        pay_type: b.payType,
        earning_code: b.code,
        hours: b.h100 == null ? null : b.h100 / 100,
        days: b.d10 == null ? null : b.d10 / 10,
        rate_cents: rate,
        amount_cents: amount
      });
    }
    return out;
  }
};

// src/lib/pay-calc/overtime.ts
var threshold = (x) => x == null ? Infinity : toHundredths(x);
function splitOvertime(current, prior, s) {
  const dtT = threshold(s.dt_daily_threshold);
  const otT = threshold(s.ot_daily_threshold);
  const weeklyT = threshold(s.ot_weekly_threshold);
  const currentDays = new Set(current.map((d) => d.day));
  const all = [...prior, ...current].map(({ day, h100 }) => {
    const dt = Math.max(0, h100 - dtT);
    const rest = h100 - dt;
    const ot = Math.max(0, rest - otT);
    return { day, reg: rest - ot, ot, dt };
  }).sort((a, b) => a.day < b.day ? -1 : a.day > b.day ? 1 : 0);
  const regByWeek = /* @__PURE__ */ new Map();
  for (const d of all) {
    const wk = weekStart(d.day, s.week_starts_on);
    const before = regByWeek.get(wk) ?? 0;
    const moved = Math.max(0, d.reg - Math.max(0, weeklyT - before));
    d.reg -= moved;
    d.ot += moved;
    regByWeek.set(wk, before + d.reg);
  }
  return all.filter((d) => currentDays.has(d.day));
}

// src/lib/pay-calc/index.ts
function compensationOn(comp, employeeId, day) {
  let best = null;
  for (const c of comp) {
    if (c.employee_id !== employeeId || c.effective_from > day) continue;
    if (!best || c.effective_from > best.effective_from) best = c;
  }
  return best;
}
function employmentDays(emp, period) {
  const start = maxDate(period.start, emp.hire_date);
  const end = emp.termination_date ? minDate(period.end, emp.termination_date) : period.end;
  return start > end ? [] : eachDay(start, end);
}
var name = (e) => `${e.first_name} ${e.last_name}`;
function calculateRun(input) {
  const { period, settings } = input;
  const skipped = new Set(input.skippedEmployeeIds);
  const periodWorkdays = eachDay(period.start, period.end).filter(isWeekday).length;
  const lines = [];
  const warnings = [];
  let employeeCount = 0;
  for (const emp of input.employees) {
    const days = employmentDays(emp, period);
    if (days.length === 0 || skipped.has(emp.id)) continue;
    const warn = (code, blocking, message) => warnings.push({ employee_id: emp.id, code, blocking, message });
    const ts = input.timesheets.find((t) => t.employee_id === emp.id);
    if (!ts || ts.status !== "approved") {
      warn("NO_APPROVED_TIMESHEET", true, `${name(emp)} has no approved timesheet`);
      continue;
    }
    const compByDay = new Map(
      days.map((d) => [d, compensationOn(input.compensation, emp.id, d)])
    );
    const missingComp = days.filter((d) => !compByDay.get(d));
    if (missingComp.length > 0) {
      warn("NO_COMPENSATION", true, `${name(emp)} has no compensation on ${missingComp[0]}${missingComp.length > 1 ? ` (+${missingComp.length - 1} more days)` : ""}`);
      continue;
    }
    const entries = [];
    for (const e of ts.entries) {
      if (compByDay.has(e.work_date)) entries.push(e);
      else warn("ENTRY_OUTSIDE_EMPLOYMENT", false, `${name(emp)}: entry on ${e.work_date} is outside employment dates and was ignored`);
    }
    const hoursPerDay = /* @__PURE__ */ new Map();
    for (const e of entries) hoursPerDay.set(e.work_date, (hoursPerDay.get(e.work_date) ?? 0) + toHundredths(e.hours ?? 0));
    const overDays = [...hoursPerDay].filter(([, h]) => h > 2400).map(([d]) => d);
    if (overDays.length > 0) {
      warn("HOURS_OVER_24", true, `${name(emp)} has more than 24 hours on ${overDays.join(", ")}`);
      continue;
    }
    const unpaid = entries.filter((e) => {
      const payType = compByDay.get(e.work_date).pay_type;
      if (payType === "hourly") return !(e.hours ?? 0) && !!(e.days ?? 0);
      if (payType === "daily") return !(e.days ?? 0) && !!(e.hours ?? 0);
      return false;
    }).map((e) => e.work_date);
    if (unpaid.length > 0) {
      warn("ENTRY_UNIT_MISMATCH", true, `${name(emp)} has time in the wrong unit for their pay type on ${[...new Set(unpaid)].join(", ")}`);
      continue;
    }
    employeeCount += 1;
    const acc = new LineAccumulator(emp);
    addSalary(acc, days, compByDay, periodWorkdays);
    addEntries(acc, entries, compByDay);
    addHourlyOvertime(acc, emp.id, entries, input.priorEntries[emp.id] ?? [], input.compensation, compByDay, settings);
    if (settings.ot_applies_to_daily) {
      addDailyOvertime(acc, emp.id, entries, input.priorEntries[emp.id] ?? [], input.compensation, compByDay, settings);
    }
    lines.push(...acc.lines());
  }
  return { lines, warnings, totals: totalsOf(lines, employeeCount) };
}
function addSalary(acc, days, compByDay, periodWorkdays) {
  const workdaysByComp = /* @__PURE__ */ new Map();
  for (const d of days) {
    const c = compByDay.get(d);
    if (c.pay_type !== "salary") continue;
    workdaysByComp.set(c, (workdaysByComp.get(c) ?? 0) + (isWeekday(d) ? 1 : 0));
  }
  for (const [c, workdays] of workdaysByComp) {
    if (workdays === 0) continue;
    acc.addFixed({
      code: "SAL",
      payType: "salary",
      rate: divRoundHalfUp(c.rate_cents, 12),
      amount: divRoundHalfUp(c.rate_cents * workdays, 12 * periodWorkdays),
      h100: null,
      d10: workdays * 10
    });
  }
}
function addEntries(acc, entries, compByDay) {
  for (const e of entries) {
    const c = compByDay.get(e.work_date);
    const h100 = toHundredths(e.hours ?? 0);
    const d10 = toTenths(e.days ?? 0);
    if (c.pay_type === "salary") {
      if (e.earning_code !== "REG") acc.addInfo(e.earning_code, "salary", h100, d10);
    } else if (c.pay_type === "hourly") {
      if (e.earning_code !== "REG") acc.addHours(e.earning_code, "hourly", c.rate_cents, 1e3, h100);
    } else {
      acc.addDays(e.earning_code, "daily", c.rate_cents, d10, h100);
    }
  }
}
function regHoursOn(entries, payType, comp) {
  return entries.filter((e) => e.earning_code === "REG" && e.hours != null && comp(e.work_date)?.pay_type === payType).map((e) => ({ day: e.work_date, h100: toHundredths(e.hours) }));
}
function addHourlyOvertime(acc, employeeId, entries, prior, allComp, compByDay, s) {
  const current = regHoursOn(entries, "hourly", (d) => compByDay.get(d) ?? null);
  if (current.length === 0) return;
  const priorHours = regHoursOn(prior, "hourly", (d) => compensationOn(allComp, employeeId, d));
  const otM = toThousandths(s.ot_multiplier);
  const dtM = toThousandths(s.dt_multiplier);
  for (const d of splitOvertime(current, priorHours, s)) {
    const rate = compByDay.get(d.day).rate_cents;
    acc.addHours("REG", "hourly", rate, 1e3, d.reg);
    acc.addHours("OT", "hourly", rate, otM, d.ot);
    acc.addHours("DT", "hourly", rate, dtM, d.dt);
  }
}
function addDailyOvertime(acc, employeeId, entries, prior, allComp, compByDay, s) {
  if (s.ot_weekly_threshold == null) return;
  const threshold2 = toHundredths(s.ot_weekly_threshold);
  const premiumM = toThousandths(s.ot_multiplier) - 1e3;
  const currentDays = new Set(entries.map((e) => e.work_date));
  const rows2 = [...prior, ...entries].filter((e) => e.earning_code === "REG").map((e) => {
    const c = currentDays.has(e.work_date) ? compByDay.get(e.work_date) ?? null : compensationOn(allComp, employeeId, e.work_date);
    return { e, c };
  }).filter((r) => r.c?.pay_type === "daily").sort((a, b) => a.e.work_date < b.e.work_date ? -1 : 1);
  const weeks = /* @__PURE__ */ new Map();
  for (const r of rows2) {
    const wk = weekStart(r.e.work_date, s.week_starts_on);
    weeks.set(wk, [...weeks.get(wk) ?? [], r]);
  }
  for (const week of weeks.values()) {
    const pay = week.reduce((sum, r) => sum + divRoundHalfUp(toTenths(r.e.days ?? 0) * r.c.rate_cents, 10), 0);
    const hours = week.reduce((sum, r) => sum + toHundredths(r.e.hours ?? 0), 0);
    if (hours <= threshold2) continue;
    let cum = 0;
    let otInPeriod = 0;
    for (const r of week) {
      const h = toHundredths(r.e.hours ?? 0);
      const over = Math.max(0, cum + h - Math.max(threshold2, cum));
      if (currentDays.has(r.e.work_date)) otInPeriod += over;
      cum += h;
    }
    if (otInPeriod === 0) continue;
    acc.addFixed({
      code: "OT",
      payType: "daily",
      rate: divRoundHalfUp(pay * 100, hours),
      amount: divRoundHalfUp(pay * otInPeriod * premiumM, hours * 1e3),
      h100: otInPeriod,
      d10: null
    });
  }
}
function totalsOf(lines, employeeCount) {
  const by = {};
  let gross = 0;
  for (const l of lines) {
    const t = by[l.earning_code] ??= { hours: 0, days: 0, amount_cents: 0 };
    t.hours = (toHundredths(t.hours) + toHundredths(l.hours ?? 0)) / 100;
    t.days = (toTenths(t.days) + toTenths(l.days ?? 0)) / 10;
    t.amount_cents += l.amount_cents;
    gross += l.amount_cents;
  }
  return { employee_count: employeeCount, gross_cents: gross, by_code: by };
}

// src/lib/db-errors.ts
var GUARD = /(CONFLICT|FORBIDDEN):([A-Z_]+): (.+?)(?: \(SQLSTATE [0-9A-Z]+\))?$/;
function parseDbError(raw) {
  const m = GUARD.exec(raw);
  if (m) return { status: m[1] === "CONFLICT" ? 409 : 403, code: m[2], message: m[3] };
  if (/duplicate key|unique constraint/i.test(raw)) return { status: 409, code: "DUPLICATE", message: "That record already exists" };
  if (/violates check constraint/i.test(raw)) return { status: 400, code: "INVALID", message: "One of the values is not allowed" };
  if (/violates foreign key constraint/i.test(raw)) return { status: 409, code: "IN_USE", message: "This record is referenced by other data" };
  return { status: 500, code: "DB_ERROR", message: raw };
}

// src/server/http.ts
var HttpError = class extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
  status;
  code;
  details;
};
var fromDbError = (err) => {
  const p = parseDbError(err.message);
  return new HttpError(p.status, p.code, p.message);
};
var JSON_HEADERS = { "Content-Type": "application/json" };
var ok = (body) => ({ statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(body) });
function errorResponse(err) {
  if (err instanceof HttpError) {
    return { statusCode: err.status, headers: JSON_HEADERS, body: JSON.stringify({ error: err.message, code: err.code, details: err.details }) };
  }
  console.error(err);
  return { statusCode: 500, headers: JSON_HEADERS, body: JSON.stringify({ error: "Internal error", code: "INTERNAL" }) };
}
function authOf(event) {
  const a = event.__volcano_auth;
  if (!a?.access_token || !a.user_id) throw new HttpError(401, "UNAUTHENTICATED", "Sign in first");
  return a;
}
function handle(fn) {
  return async (event) => {
    try {
      return ok(await fn(event && typeof event === "object" && !Array.isArray(event) ? event : {}));
    } catch (err) {
      return errorResponse(err);
    }
  };
}
function requireString(v, name2) {
  if (typeof v !== "string" || v.trim() === "") throw new HttpError(400, "BAD_REQUEST", `${name2} is required`);
  return v.trim();
}

// src/server/db.ts
async function rows(q) {
  const { data, error } = await q;
  if (error) throw fromDbError(error);
  return data ?? [];
}
async function one(q, notFound = "Not found") {
  const [row] = await rows(q);
  if (!row) throw new HttpError(404, "NOT_FOUND", notFound);
  return row;
}
async function mutated(q, what) {
  const out = await rows(q);
  if (out.length === 0) throw new HttpError(403, "FORBIDDEN", `Not allowed to change ${what}, or it does not exist`);
  return out;
}
async function selectAll(page, size = 1e3) {
  const out = [];
  for (let offset = 0; ; offset += size) {
    const batch = await rows(page(offset, size));
    out.push(...batch);
    if (batch.length < size) return out;
  }
}
var asJson = (v) => JSON.stringify(v);
var num = (v) => v == null ? null : Number(v);
var isoDate = (v) => String(v).slice(0, 10);
function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// src/server/auth.ts
async function requireEmployee(db, auth, roles) {
  const [me] = await rows(
    db.from("employees").select("id,role,first_name,last_name,email").eq("user_id", auth.user_id).eq("status", "active").limit(1)
  );
  if (!me) throw new HttpError(403, "NOT_INVITED", "No active employee record is linked to this account");
  if (roles && !roles.includes(me.role)) throw new HttpError(403, "FORBIDDEN", `This needs the ${roles.join(" or ")} role`);
  return me;
}

// src/server/payroll-data.ts
async function loadPeriod(db, periodId) {
  const p = await one(db.from("pay_periods").select("id,start_date,end_date,status").eq("id", periodId), "Pay period not found");
  return { ...p, start_date: isoDate(p.start_date), end_date: isoDate(p.end_date) };
}
async function loadSettings(db) {
  const s = await one(db.from("settings").select(
    "ot_weekly_threshold,ot_daily_threshold,dt_daily_threshold,ot_multiplier,dt_multiplier,ot_applies_to_daily,week_starts_on"
  ));
  return {
    ot_weekly_threshold: num(s.ot_weekly_threshold),
    ot_daily_threshold: num(s.ot_daily_threshold),
    dt_daily_threshold: num(s.dt_daily_threshold),
    ot_multiplier: num(s.ot_multiplier) ?? 1.5,
    dt_multiplier: num(s.dt_multiplier) ?? 2,
    ot_applies_to_daily: s.ot_applies_to_daily === true,
    week_starts_on: num(s.week_starts_on) ?? 0
  };
}
async function loadTimesheets(db, periodId) {
  return selectAll((o, l) => db.from("timesheets").select("id,employee_id,status").eq("pay_period_id", periodId).order("id").limit(l).offset(o));
}
async function loadEntries(db, timesheetIds) {
  const out = [];
  for (const ids of chunk(timesheetIds, 100)) {
    out.push(...await selectAll((o, l) => db.from("time_entries").select("timesheet_id,work_date,earning_code,hours,days").in("timesheet_id", ids).order("id").limit(l).offset(o)));
  }
  return out;
}
var toEntry = (e) => ({
  work_date: isoDate(e.work_date),
  earning_code: e.earning_code,
  hours: num(e.hours),
  days: num(e.days)
});
async function loadCalcInput(db, period, skippedEmployeeIds) {
  const settings = await loadSettings(db);
  const employees = (await selectAll((o, l) => db.from("employees").select("id,external_id,first_name,last_name,email,work_state,hire_date,termination_date").lte("hire_date", period.end_date).order("id").limit(l).offset(o))).map((e) => ({ ...e, hire_date: isoDate(e.hire_date), termination_date: e.termination_date ? isoDate(e.termination_date) : null })).filter((e) => !e.termination_date || e.termination_date >= period.start_date);
  const compensation = (await selectAll((o, l) => db.from("compensation").select("employee_id,pay_type,rate_cents,effective_from").order("id").limit(l).offset(o))).map((c) => ({ ...c, rate_cents: Number(c.rate_cents), effective_from: isoDate(c.effective_from) }));
  const sheets = await loadTimesheets(db, period.id);
  const entries = await loadEntries(db, sheets.map((t) => t.id));
  const timesheets = sheets.map((t) => ({
    employee_id: t.employee_id,
    status: t.status,
    entries: entries.filter((e) => e.timesheet_id === t.id).map(toEntry)
  }));
  const priorEntries = {};
  const firstWeek = weekStart(period.start_date, settings.week_starts_on);
  if (firstWeek < period.start_date) {
    const prevStart = monthBounds(addDays(period.start_date, -1).slice(0, 7)).start;
    const [prev] = await rows(db.from("pay_periods").select("id").eq("start_date", prevStart).limit(1));
    if (prev) {
      const prevSheets = (await loadTimesheets(db, prev.id)).filter((t) => t.status === "approved");
      const prevEntries = await loadEntries(db, prevSheets.map((t) => t.id));
      for (const t of prevSheets) {
        priorEntries[t.employee_id] = prevEntries.filter((e) => e.timesheet_id === t.id).map(toEntry).filter((e) => e.work_date >= firstWeek);
      }
    }
  }
  return {
    period: { start: period.start_date, end: period.end_date },
    employees,
    compensation,
    timesheets,
    priorEntries,
    settings,
    skippedEmployeeIds
  };
}

// node_modules/@volcano.dev/sdk/dist/index.esm.mjs
function responseHeadersToObject(response) {
  const result = {};
  const headers = response?.headers;
  if (headers == null) {
    return result;
  }
  if (typeof headers.forEach === "function") {
    headers.forEach((value, key) => {
      result[key] = value;
    });
    return result;
  }
  if (typeof headers.entries === "function") {
    copyHeaderEntries(headers.entries(), result);
  }
  return result;
}
function copyHeaderEntries(entries, target) {
  for (const [key, value] of entries) {
    target[key] = value;
  }
}
function getHeaderValue(response, headerName) {
  const headers = response?.headers;
  if (headers == null) {
    return null;
  }
  if (typeof headers.get === "function") {
    return headers.get(headerName);
  }
  return findHeaderValue(headers, headerName);
}
function findHeaderValue(headers, headerName) {
  const lowerName = headerName.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lowerName) {
      const value = Reflect.get(headers, key);
      return value;
    }
  }
  return null;
}
function errorResult(message, extra = {}) {
  const error = message instanceof Error ? message : new Error(message);
  return { data: null, error, ...extra };
}
function apiRequestError(response, data, message = errorMessage$2(data)) {
  const error = Object.assign(new Error(message), { status: response.status });
  const code = stringField(data, "code");
  if (code !== void 0) {
    error.code = code;
  }
  const retrySeconds = retryAfterSeconds(response);
  if (retrySeconds !== void 0) {
    error.retryAfter = retrySeconds;
  }
  return error;
}
function errorMessage$2(data) {
  return stringField(data, "error") ?? "Request failed";
}
function stringField(data, key) {
  if (!isRecord$8(data)) {
    return void 0;
  }
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : void 0;
}
function retryAfterSeconds(response) {
  const header = getHeaderValue(response, "retry-after");
  if (typeof header !== "string") {
    return void 0;
  }
  const seconds = Number.parseInt(header, 10);
  return Number.isFinite(seconds) ? seconds : void 0;
}
function isRecord$8(value) {
  return typeof value === "object" && value !== null;
}
var FilterBuilder = class {
  filters = [];
  eq(column, value) {
    this.filters.push({ column, operator: "eq", value });
    return this;
  }
  neq(column, value) {
    this.filters.push({ column, operator: "neq", value });
    return this;
  }
  gt(column, value) {
    this.filters.push({ column, operator: "gt", value });
    return this;
  }
  gte(column, value) {
    this.filters.push({ column, operator: "gte", value });
    return this;
  }
  lt(column, value) {
    this.filters.push({ column, operator: "lt", value });
    return this;
  }
  lte(column, value) {
    this.filters.push({ column, operator: "lte", value });
    return this;
  }
  like(column, pattern) {
    this.filters.push({ column, operator: "like", value: pattern });
    return this;
  }
  ilike(column, pattern) {
    this.filters.push({ column, operator: "ilike", value: pattern });
    return this;
  }
  is(column, value) {
    this.filters.push({ column, operator: "is", value });
    return this;
  }
  in(column, values) {
    this.filters.push({ column, operator: "in", value: values });
    return this;
  }
};
async function readBody(response) {
  const contentType = response.headers.get("content-type")?.toLowerCase();
  if (isJsonContentType(contentType) || typeof response.blob !== "function") {
    return response.json();
  }
  if (isTextContentType(contentType)) {
    return response.text();
  }
  return response.blob();
}
function isJsonContentType(contentType) {
  return contentType?.includes("json") === true;
}
function isTextContentType(contentType) {
  return contentType?.startsWith("text/") === true;
}
async function responseData(response, responseType) {
  if ([204, 205, 304].includes(response.status)) {
    return void 0;
  }
  if (response.ok && responseType === "blob") {
    return response.blob();
  }
  return readBody(response);
}
function responseError$1(response, data) {
  const message = errorMessage$1(response.status, data);
  const error = Object.assign(new Error(message), { info: data, status: response.status });
  if (hasErrorCode(data)) {
    Object.assign(error, { code: data.code });
  }
  const retryAfter = retryDelay(response);
  if (retryAfter !== void 0) {
    Object.assign(error, { retryAfter });
  }
  return error;
}
function retryDelay(response) {
  const seconds = Number.parseInt(String(response.headers.get("retry-after")), 10);
  return Number.isFinite(seconds) ? seconds : void 0;
}
function hasErrorCode(data) {
  return typeof data === "object" && data !== null && "code" in data;
}
function errorMessage$1(status, data) {
  if (typeof data === "object" && data !== null && "error" in data) {
    return String(data.error);
  }
  return `Request failed with status ${String(status)}`;
}
async function volcanoFetch(path, options) {
  const { volcanoAuthorization, volcanoClient, volcanoResponseType, ...request } = options;
  if (volcanoClient === void 0 || volcanoAuthorization === void 0) {
    throw new Error("Generated transport requires a Volcano client and authorization mode");
  }
  const response = await volcanoClient._generatedFetch(path, request, volcanoAuthorization);
  const data = await responseData(response, volcanoResponseType);
  if (!response.ok) {
    throw responseError$1(response, data);
  }
  return { data, status: response.status, headers: response.headers };
}
var getStartDurableExecutionFromApplicationUrl = (functionId) => {
  return `/durable-functions/${functionId}/executions`;
};
var startDurableExecutionFromApplication = async (functionId, startDurableExecutionFromApplicationBody, options) => {
  const getHeaders = (h) => {
    if (!h)
      return {};
    if (h instanceof Headers)
      return Object.fromEntries(h.entries());
    if (Array.isArray(h))
      return Object.fromEntries(h);
    return h;
  };
  return volcanoFetch(getStartDurableExecutionFromApplicationUrl(functionId), {
    ...options,
    method: "POST",
    headers: { "Content-Type": "application/json", ...getHeaders(options?.headers) },
    body: JSON.stringify(startDurableExecutionFromApplicationBody)
  });
};
var getListDurableExecutionsUrl = (id, functionId, params) => {
  const normalizedParams = new URLSearchParams();
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== void 0) {
      normalizedParams.append(key, value === null ? "null" : String(value));
    }
  });
  const stringifiedParams = normalizedParams.toString();
  return stringifiedParams.length > 0 ? `/projects/${id}/durable-functions/${functionId}/executions?${stringifiedParams}` : `/projects/${id}/durable-functions/${functionId}/executions`;
};
var listDurableExecutions = async (id, functionId, params, options) => {
  return volcanoFetch(getListDurableExecutionsUrl(id, functionId, params), {
    ...options,
    method: "GET"
  });
};
var getGetDurableExecutionUrl = (id, functionId, executionId) => {
  return `/projects/${id}/durable-functions/${functionId}/executions/${executionId}`;
};
var getDurableExecution = async (id, functionId, executionId, options) => {
  return volcanoFetch(getGetDurableExecutionUrl(id, functionId, executionId), {
    ...options,
    method: "GET"
  });
};
var getStopDurableExecutionUrl = (id, functionId, executionId) => {
  return `/projects/${id}/durable-functions/${functionId}/executions/${executionId}/stop`;
};
var stopDurableExecution = async (id, functionId, executionId, options) => {
  return volcanoFetch(getStopDurableExecutionUrl(id, functionId, executionId), {
    ...options,
    method: "POST"
  });
};
var getQueryDatabaseSelectUrl = (databaseName2) => {
  return `/databases/${databaseName2}/query/select`;
};
var getAuthSigninUrl = () => {
  return `/auth/signin`;
};
var authSignin = async (authSigninBody, options) => {
  const getHeaders = (h) => {
    if (!h)
      return {};
    if (h instanceof Headers)
      return Object.fromEntries(h.entries());
    if (Array.isArray(h))
      return Object.fromEntries(h);
    return h;
  };
  return volcanoFetch(getAuthSigninUrl(), {
    ...options,
    method: "POST",
    headers: { "Content-Type": "application/json", ...getHeaders(options?.headers) },
    body: JSON.stringify(authSigninBody)
  });
};
var getAcquireProjectLockUrl = (key) => {
  return `/locks/${key}/lease`;
};
var acquireProjectLock = async (key, projectLockLeaseRequest, options) => {
  const getHeaders = (h) => {
    if (!h)
      return {};
    if (h instanceof Headers)
      return Object.fromEntries(h.entries());
    if (Array.isArray(h))
      return Object.fromEntries(h);
    return h;
  };
  return volcanoFetch(getAcquireProjectLockUrl(key), {
    ...options,
    method: "POST",
    headers: { "Content-Type": "application/json", ...getHeaders(options?.headers) },
    body: JSON.stringify(projectLockLeaseRequest)
  });
};
var getReleaseProjectLockUrl = (key) => {
  return `/locks/${key}/lease`;
};
var releaseProjectLock = async (key, options) => {
  return volcanoFetch(getReleaseProjectLockUrl(key), {
    ...options,
    method: "DELETE"
  });
};
var getUploadStorageObjectUrl = (bucketName, path) => {
  return `/storage/${bucketName}/${path}`;
};
var uploadStorageObject = async (bucketName, path, uploadStorageObjectBodyOne, options) => {
  const formData = new FormData();
  formData.append(`file`, uploadStorageObjectBodyOne.file);
  return volcanoFetch(getUploadStorageObjectUrl(bucketName, path), {
    ...options,
    method: "POST",
    body: formData
  });
};
var getDownloadStorageObjectUrl = (bucketName, path) => {
  return `/storage/${bucketName}/${path}`;
};
var downloadStorageObject = async (bucketName, path, options) => {
  return volcanoFetch(getDownloadStorageObjectUrl(bucketName, path), {
    ...options,
    method: "GET"
  });
};
async function queryDatabaseSelectTransport(databaseName2, request, options) {
  const headers = new Headers(options.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return volcanoFetch(getQueryDatabaseSelectUrl(databaseName2), {
    ...options,
    method: "POST",
    headers,
    body: JSON.stringify(request)
  });
}
var QueryBuilder$1 = class QueryBuilder extends FilterBuilder {
  client;
  table;
  databaseName;
  orderClauses = [];
  selectColumns = [];
  limitValue = null;
  offsetValue = null;
  constructor(client, table, databaseName2) {
    super();
    this.client = client;
    this.table = table;
    this.databaseName = databaseName2;
  }
  select(columns) {
    if (columns === "*") {
      this.selectColumns = [];
    } else if (Array.isArray(columns)) {
      this.selectColumns = columns;
    } else {
      this.selectColumns = columns.split(",").map((column) => column.trim());
    }
    return this;
  }
  order(column, options = {}) {
    this.orderClauses.push({ column, ascending: options.ascending !== false });
    return this;
  }
  limit(count) {
    this.limitValue = count;
    return this;
  }
  offset(count) {
    this.offsetValue = count;
    return this;
  }
  async execute() {
    await this.client._completeOAuthExchange();
    const preflight = this.preflight();
    if (!preflight.ok) {
      return preflight.result;
    }
    try {
      return await this.request(preflight.databaseName);
    } catch (error) {
      return { data: null, error: queryError(error), count: 0 };
    }
  }
  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }
  preflight() {
    if (this.client.accessToken === null || this.client.accessToken.length === 0) {
      return {
        ok: false,
        result: { ...errorResult(sessionError$1(this.client._oauthExchangeError)), count: 0 }
      };
    }
    const databaseName2 = this.databaseName;
    if (databaseName2 === null || databaseName2.length === 0) {
      return {
        ok: false,
        result: {
          ...errorResult("Database name not set. Use .database(databaseName) first."),
          count: 0
        }
      };
    }
    return { ok: true, databaseName: databaseName2 };
  }
  async request(databaseName2) {
    const response = await this.client._transport.queryDatabaseSelect(encodeURIComponent(databaseName2), this.requestBody(), this.client._generatedOptions("session"));
    const payload = queryPayload(response.data);
    return {
      data: payload.rows,
      error: null,
      count: queryCount(payload.count, payload.rows.length)
    };
  }
  requestBody() {
    const body = { table: this.table };
    if (this.selectColumns.length > 0) {
      body.select = this.selectColumns;
    }
    if (this.filters.length > 0) {
      body.filters = this.filters;
    }
    if (this.orderClauses.length > 0) {
      body.order = this.orderClauses;
    }
    this.addPagination(body);
    return body;
  }
  addPagination(body) {
    if (this.limitValue !== null) {
      body.limit = this.limitValue;
    }
    if (this.offsetValue !== null) {
      body.offset = this.offsetValue;
    }
  }
};
function queryError(error) {
  return error instanceof Error ? error : new Error("Query failed");
}
function sessionError$1(error) {
  if (error instanceof Error) {
    return error;
  }
  return new Error(error !== null && error.length > 0 ? error : "No active session. Please sign in first.");
}
function queryPayload(value) {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Query response is not an object");
  }
  if (!("data" in value) || !Array.isArray(value.data)) {
    throw new TypeError("Query response has no rows");
  }
  const rows2 = value.data;
  return { rows: rows2, count: responseCount(value) };
}
function responseCount(value) {
  return "count" in value ? value.count : void 0;
}
function queryCount(count, rowCount) {
  return typeof count === "number" && count !== 0 ? count : rowCount;
}
var AuthRefreshDiscardedError = class extends Error {
  constructor() {
    super("Refresh result discarded because the auth session changed");
    Object.defineProperty(this, "code", { value: "auth_refresh_discarded" });
    Object.defineProperty(this, "status", { value: 409 });
  }
  static is(error) {
    return hasValue(error, "name", "AuthRefreshDiscardedError") && hasValue(error, "code", "auth_refresh_discarded") && hasValue(error, "status", 409);
  }
};
Object.assign(AuthRefreshDiscardedError.prototype, { name: "AuthRefreshDiscardedError" });
var AuthSessionChangedError = class extends Error {
  constructor() {
    super("Auth operation discarded because the session changed");
    Object.defineProperty(this, "code", { value: "auth_session_changed" });
    Object.defineProperty(this, "status", { value: 409 });
  }
  static is(error) {
    return hasValue(error, "name", "AuthSessionChangedError") && hasValue(error, "code", "auth_session_changed") && hasValue(error, "status", 409);
  }
};
Object.assign(AuthSessionChangedError.prototype, { name: "AuthSessionChangedError" });
var VolcanoSystemError = class extends Error {
  constructor(message, options = {}) {
    super(message, errorCause(options));
    Object.defineProperty(this, "isSystemError", { value: true });
    Object.defineProperty(this, "status", { value: options.status ?? null });
    if (options.code !== void 0) {
      Object.defineProperty(this, "code", { value: options.code });
    }
    if (options.retryAfter !== void 0) {
      Object.defineProperty(this, "retryAfter", { value: options.retryAfter });
    }
  }
  /**
   * Type guard: true when `err` is a platform-layer invocation failure. Prefer
   * this over `instanceof` — it duck-types on the `isSystemError` brand, so it
   * holds across duplicate SDK copies in a bundle.
   * @param {unknown} err
   * @returns {boolean}
   */
  static is(err) {
    return hasValue(err, "isSystemError", true);
  }
};
Object.assign(VolcanoSystemError.prototype, { name: "VolcanoSystemError" });
function errorCause(options) {
  return options.cause !== void 0 ? { cause: options.cause } : void 0;
}
var BoxValue = Object;
function hasValue(value, key, expected) {
  if (!Boolean(value)) {
    return false;
  }
  const property = Reflect.get(new BoxValue(value), key, value);
  return property === expected;
}
var defaultTimeoutMs = 6e4;
function fetchWithTimeout(url, options = {}, timeoutMs = defaultTimeoutMs, consume = (response) => response) {
  return performFetch(url, options, timeoutMs, consume);
}
async function performFetch(url, options, timeoutMs, consume) {
  const controller = new AbortController();
  const caller = options.signal;
  const unfollow = followCaller(caller, controller);
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return await consume(response, controller.signal);
  } catch (error) {
    if (isRequestTimeout(error, timedOut, caller)) {
      throw new Error(`Request timeout after ${String(timeoutMs)}ms`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    unfollow?.();
  }
}
function followCaller(signal, controller) {
  if (signal == null) {
    return void 0;
  }
  const abort = () => {
    const reason = signal.reason;
    controller.abort(reason);
  };
  if (signal.aborted) {
    abort();
  } else {
    signal.addEventListener("abort", abort);
  }
  return () => {
    signal.removeEventListener("abort", abort);
  };
}
function isRequestTimeout(error, timedOut, caller) {
  return hasAbortName$1(error) && timedOut && caller?.aborted !== true;
}
function hasAbortName$1(value) {
  if (typeof value !== "object" && typeof value !== "function" || value === null) {
    return false;
  }
  return "name" in value && value.name === "AbortError";
}
async function fetchWithAuthRetry(client, url, options = {}) {
  await client._completeOAuthExchange();
  const context = client._captureAuthContext();
  const doFetch = (accessToken) => {
    return fetchWithTimeout(url, {
      ...options,
      headers: authenticatedHeaders(options.headers, accessToken)
    }, client.timeout);
  };
  const response = await doFetch(context.accessToken);
  if (response.status !== 401) {
    return response;
  }
  return retryAfterUnauthorized$1(client, context, response, doFetch);
}
function authenticatedHeaders(source, accessToken) {
  const headers = source instanceof Headers || Array.isArray(source) ? Object.fromEntries(new Headers(source).entries()) : { ...source };
  const authenticated = {};
  for (const [name2, value] of Object.entries(headers)) {
    if (name2.toLowerCase() !== "authorization") {
      authenticated[name2] = value;
    }
  }
  authenticated["Authorization"] = `Bearer ${String(accessToken)}`;
  return authenticated;
}
async function retryAfterUnauthorized$1(client, context, response, doFetch) {
  const refreshed = await client._refreshSessionForContext(context);
  if (AuthRefreshDiscardedError.is(refreshed.error)) {
    throw refreshed.error;
  }
  if (refreshed.error != null) {
    return response;
  }
  if (!client._isAuthContextCurrent(context)) {
    throw new AuthRefreshDiscardedError();
  }
  return doFetch(client.accessToken);
}
function encodeStoragePath(path) {
  return path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}
function buildStorageUrl(apiUrl2, bucketName, encodedPath) {
  return `${apiUrl2}/storage/${encodeURIComponent(bucketName)}/${encodedPath}`;
}
function publicStoragePathError(path) {
  if (typeof path !== "string" || path.length === 0) {
    return "Storage path must be a non-empty string";
  }
  if (path.split("/").some((segment) => segment === "." || segment === "..")) {
    return "Public URL paths cannot contain dot segments";
  }
  return null;
}
function decodeBase64Url(value) {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  if (typeof atob === "function") {
    return atob(base64);
  }
  if (typeof Buffer !== "undefined") {
    return Buffer.from(base64, "base64").toString("utf-8");
  }
  throw new Error("No base64 decoder available");
}
function extractRequiredProjectIdFromToken(token, tokenName = "accessToken") {
  if (typeof token !== "string" || token === "") {
    throw new Error("No active session");
  }
  const encoded = encodedPayload(token);
  if (encoded === null) {
    throw new Error(`${tokenName} must be a JWT with project_id claim`);
  }
  const payload = projectPayload(encoded, tokenName);
  return requiredProjectId(payload, tokenName);
}
function extractSessionIdFromToken(token) {
  if (typeof token !== "string") {
    return null;
  }
  const parsed = parseSessionPayload(token);
  return parsed === null ? null : normalizedSessionId(parsed.payload);
}
function parseSessionPayload(token) {
  const parts = token.split(".");
  if (!hasThreeSegments$1(parts)) {
    return null;
  }
  try {
    return { payload: JSON.parse(decodeBase64Url(parts[1])) };
  } catch {
    return null;
  }
}
function encodedPayload(token) {
  const parts = token.split(".");
  return hasThreeSegments$1(parts) ? parts[1] : null;
}
function hasThreeSegments$1(parts) {
  return parts.length === 3;
}
function projectPayload(encoded, tokenName) {
  try {
    return JSON.parse(decodeBase64Url(encoded));
  } catch {
    throw new Error(`${tokenName} must be a valid JWT with project_id claim`);
  }
}
function claim$1(payload, name2) {
  if (typeof payload !== "object" || payload === null) {
    return void 0;
  }
  return Reflect.get(payload, name2);
}
function requiredProjectId(payload, tokenName) {
  const projectId = claim$1(payload, "project_id");
  if (typeof projectId !== "string" || projectId.trim() === "") {
    throw new Error(`${tokenName} missing project_id claim`);
  }
  return projectId.trim();
}
function normalizedSessionId(payload) {
  const sessionId = claim$1(payload, "session_id");
  return typeof sessionId === "string" && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(sessionId) ? sessionId.toLowerCase() : null;
}
function storagePublicUrl(apiUrl2, bucketName, anonKey, path) {
  const pathError = publicStoragePathError(path);
  if (pathError !== null) {
    return errorResult(pathError);
  }
  const parts = anonKey.split(".");
  if (!isTokenParts(parts)) {
    return errorResult("Invalid anon key format");
  }
  try {
    const payload = JSON.parse(decodeBase64Url(parts[1]));
    const projectId = projectIdFrom(payload);
    if (projectId === null) {
      return errorResult("Project ID not found in anon key");
    }
    const encodedPath = encodeStoragePath(path);
    const publicUrl = `${apiUrl2}/public/${projectId}/${encodeURIComponent(bucketName)}/${encodedPath}`;
    return { data: { publicUrl }, error: null };
  } catch (error) {
    return errorResult(`Failed to parse anon key: ${parseErrorMessage(error)}`);
  }
}
function isTokenParts(parts) {
  return parts.length === 3;
}
function projectIdFrom(payload) {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const projectId = Reflect.get(payload, "project_id");
  return nonEmptyProjectId(projectId);
}
function nonEmptyProjectId(projectId) {
  return typeof projectId === "string" && projectId.length > 0 ? projectId : null;
}
function parseErrorMessage(error) {
  return error instanceof Error ? error.message : "Unknown error";
}
var DEFAULT_UPLOAD_PART_SIZE = 26214400;
async function uploadResumable(host, path, fileBody, options = {}) {
  const authError = await host._checkAuth();
  if (authError !== null) {
    return authError;
  }
  return startUpload(host, path, fileBody, options);
}
async function startUpload(host, path, fileBody, options) {
  try {
    const started = await host.createUploadSession(path, {
      totalSize: fileBody.size,
      contentType: uploadContentType(fileBody, options.contentType),
      partSize: uploadPartSize(options.partSize)
    });
    if (started.error !== null) {
      return { data: null, error: started.error };
    }
    return await uploadParts(host, path, fileBody, sessionFrom(started.data), options.onProgress);
  } catch (error) {
    return {
      data: null,
      error: error instanceof Error ? error : new Error("Resumable upload failed")
    };
  }
}
function uploadContentType(fileBody, configured) {
  if (configured !== void 0 && configured.length > 0) {
    return configured;
  }
  const fileType = fileBody instanceof File ? fileBody.type : "";
  return fileType.length > 0 ? fileType : "application/octet-stream";
}
function uploadPartSize(configured) {
  return configured === void 0 || configured === 0 ? DEFAULT_UPLOAD_PART_SIZE : configured;
}
function sessionFrom(value) {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Upload session response is not an object");
  }
  return {
    sessionId: requiredSessionId(value),
    totalParts: requiredCount(value),
    partSize: requiredPartSize(value)
  };
}
function requiredSessionId(value) {
  if (!("session_id" in value) || typeof value.session_id !== "string") {
    throw new TypeError("Upload session has no ID");
  }
  return value.session_id;
}
function requiredCount(value) {
  if (!("total_parts" in value) || !validCount(value.total_parts)) {
    throw new TypeError("Upload session has an invalid part count");
  }
  return value.total_parts;
}
function requiredPartSize(value) {
  if (!("part_size" in value) || !validPartSize(value.part_size)) {
    throw new TypeError("Upload session has an invalid part size");
  }
  return value.part_size;
}
function validCount(value) {
  return Number.isInteger(value) && Number(value) >= 0;
}
function validPartSize(value) {
  return Number.isInteger(value) && Number(value) > 0;
}
async function uploadParts(host, path, fileBody, session, onProgress) {
  for (let partNumber = 1; partNumber <= session.totalParts; partNumber += 1) {
    const start = (partNumber - 1) * session.partSize;
    const end = Math.min(start + session.partSize, fileBody.size);
    const partData = fileBody.slice(start, end);
    const result = await host.uploadPart(path, session.sessionId, partNumber, partData);
    if (result.error !== null) {
      return abortFailedPart(host, path, session.sessionId, result.error);
    }
    if (onProgress !== void 0) {
      onProgress(end, fileBody.size);
    }
  }
  return host.completeUploadSession(path, session.sessionId);
}
async function abortFailedPart(host, path, sessionId, partError) {
  const aborted = await host.abortUploadSession(path, sessionId);
  if (aborted.error !== null) {
    console.warn(`[Storage] Failed to abort upload session ${sessionId}:`, aborted.error.message);
  }
  return { data: null, error: partError };
}
function isRecord$7(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || Object.getPrototypeOf(prototype) === null;
}
function isInteger(value) {
  return Number.isInteger(value) && Number(value) >= 0;
}
function hasStringFields(value, fields) {
  return fields.every((field) => typeof value[field] === "string");
}
function hasOptionalIntegerFields(value, fields) {
  return fields.every((field) => !Object.hasOwn(value, field) || isInteger(value[field]));
}
function hasOptionalStringFields(value, fields) {
  return fields.every((field) => !Object.hasOwn(value, field) || typeof value[field] === "string");
}
function isJsonScalar$2(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  return Number.isFinite(value);
}
function isJsonValue$2(value) {
  if (isJsonScalar$2(value)) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue$2);
  }
  return isRecord$7(value) && Object.values(value).every(isJsonValue$2);
}
function hasOptionalMetadata(value) {
  return !Object.hasOwn(value, "metadata") || isRecord$7(value["metadata"]) && isJsonValue$2(value["metadata"]);
}
function hasOptionalOwner(value) {
  return !Object.hasOwn(value, "owner_id") || value["owner_id"] === null || typeof value["owner_id"] === "string";
}
function hasStorageObjectCore(value) {
  return hasStringFields(value, ["id", "bucket_id", "name", "mime_type"]) && isInteger(value["size"]) && typeof value["is_public"] === "boolean";
}
function hasStorageObjectOptionals(value) {
  return hasOptionalOwner(value) && hasOptionalStringFields(value, ["etag", "created_at", "updated_at", "public_url"]) && hasOptionalMetadata(value);
}
function isStorageObject(value) {
  return isRecord$7(value) && hasStorageObjectCore(value) && hasStorageObjectOptionals(value);
}
function isStorageObjects(value) {
  return Array.isArray(value) && value.every(isStorageObject);
}
function isBlob(value) {
  return value instanceof Blob;
}
function isUploadSession(value) {
  return isRecord$7(value) && hasOptionalStringFields(value, ["session_id", "expires_at"]) && hasOptionalIntegerFields(value, ["part_size", "total_parts"]);
}
function isUploadPart(value) {
  return isRecord$7(value) && hasOptionalStringFields(value, ["etag"]) && hasOptionalIntegerFields(value, ["part_number", "size"]);
}
function isCompletedUpload(value) {
  return isRecord$7(value) && (!Object.hasOwn(value, "object") || isStorageObject(value["object"]));
}
function isUploadStatus(value) {
  return value === "pending" || value === "uploading" || value === "completing" || value === "completed" || value === "aborted";
}
function hasUploadStatusCore(value) {
  return hasOptionalStringFields(value, [
    "session_id",
    "path",
    "content_type",
    "expires_at",
    "created_at"
  ]) && hasOptionalIntegerFields(value, [
    "total_size",
    "part_size",
    "total_parts",
    "parts_uploaded",
    "bytes_uploaded"
  ]) && (!Object.hasOwn(value, "status") || isUploadStatus(value["status"]));
}
function isUploadSessionStatus(value) {
  return isRecord$7(value) && hasUploadStatusCore(value) && (!Object.hasOwn(value, "parts") || Array.isArray(value["parts"]) && value["parts"].every(isUploadPart));
}
async function safeJsonParse(response, signal) {
  try {
    const value = await response.json();
    return value;
  } catch (error) {
    if (signal?.aborted === true) {
      throw cancellationReason(signal, error);
    }
    if (hasAbortName(error)) {
      throw error;
    }
    return {};
  }
}
function cancellationReason(signal, fallback) {
  const reason = signal.reason;
  return Boolean(reason) ? reason : fallback;
}
function hasAbortName(value) {
  if (typeof value !== "object" && typeof value !== "function" || value === null) {
    return false;
  }
  return "name" in value && value.name === "AbortError";
}
async function storageRequest(fetcher, url, options = {}) {
  try {
    const response = await fetcher(url, options);
    if (options.responseType === "blob") {
      return await blobResult(response);
    }
    return await jsonResult(response);
  } catch (error) {
    return { data: null, error: error instanceof Error ? error : new Error("Request failed") };
  }
}
async function blobResult(response) {
  if (!response.ok) {
    return { data: null, error: apiRequestError(response, await safeJsonParse(response)) };
  }
  return { data: await response.blob(), error: null };
}
async function jsonResult(response) {
  const data = await safeJsonParse(response);
  return response.ok ? { data, error: null } : { data: null, error: apiRequestError(response, data) };
}
function validatedResult(result, guard, responseName) {
  if (result.error !== null) {
    return { data: null, error: result.error };
  }
  if (!guard(result.data)) {
    return { data: null, error: new TypeError(`Invalid ${responseName} response`) };
  }
  return { data: result.data, error: null };
}
function legacyStringDefault(value, fallback) {
  return Boolean(value) ? String(value) : fallback;
}
function legacyValueDefault(value, fallback) {
  return Boolean(value) ? value : fallback;
}
function uploadFileBody(path, fileBody, options) {
  if (fileBody instanceof File) {
    return fileBody;
  }
  if (fileBody instanceof Blob || fileBody instanceof ArrayBuffer) {
    return new File([fileBody], legacyStringDefault(path.split("/").pop(), "file"), {
      type: legacyStringDefault(options.contentType, "application/octet-stream")
    });
  }
  return null;
}
function downloadHeaders(options) {
  const range = options.range;
  return Boolean(range) ? { Range: String(range) } : void 0;
}
function listUrl(host, prefix, options) {
  const params = new URLSearchParams();
  if (Boolean(prefix)) {
    params.set("prefix", String(prefix));
  }
  if (Boolean(options.limit)) {
    params.set("limit", String(options.limit));
  }
  if (Boolean(options.cursor)) {
    params.set("cursor", String(options.cursor));
  }
  const query = params.toString();
  const base = `${host.volcanoAuth.apiUrl}/storage/${encodeURIComponent(host.bucketName)}`;
  return query.length > 0 ? `${base}?${query}` : base;
}
function listFailure(error) {
  return { data: null, error, nextCursor: null };
}
function listObjects(value) {
  const objects = Reflect.get(value, "objects");
  if (!Boolean(objects)) {
    return [];
  }
  return isStorageObjects(objects) ? objects : null;
}
function listCursor(value) {
  const cursor = Reflect.get(value, "next_cursor");
  return typeof cursor === "string" && cursor.length > 0 ? cursor : null;
}
function listPayload(value) {
  if (typeof value !== "object" || value === null) {
    return listFailure(new TypeError("Storage list response is not an object"));
  }
  const objects = listObjects(value);
  if (objects === null) {
    return listFailure(new TypeError("Storage list response has invalid objects"));
  }
  return { data: objects, error: null, nextCursor: listCursor(value) };
}
async function uploadWithFile(host, path, fileBody, options) {
  try {
    const file = uploadFileBody(path, fileBody, options);
    if (file === null) {
      return errorResult("Invalid file body type. Expected File, Blob, or ArrayBuffer.");
    }
    const response = await host.volcanoAuth._transport.uploadStorageObject(encodeURIComponent(host.bucketName), host._encodePath(path), { file }, host.volcanoAuth._generatedOptions("session"));
    return validatedResult({ data: response.data, error: null }, isStorageObject, "storage upload");
  } catch (error) {
    return { data: null, error: error instanceof Error ? error : new Error("Upload failed") };
  }
}
async function deletePaths(host, paths) {
  const deleted = [];
  const failures = [];
  for (const path of Array.isArray(paths) ? paths : [paths]) {
    const result = await host._storageRequest(host._buildUrl(path), { method: "DELETE" });
    if (result.error === null) {
      deleted.push(path);
    } else {
      failures.push({ path, error: result.error });
    }
  }
  return { deleted, failures };
}
function uploadSessionBody(path, options) {
  return {
    filename: legacyStringDefault(path.split("/").pop(), path),
    content_type: legacyValueDefault(options.contentType, "application/octet-stream"),
    total_size: options.totalSize,
    part_size: options.partSize
  };
}
function removeError(failures, firstError) {
  const error = Object.assign(new Error(`Failed to delete ${String(failures.length)} file(s): ${failures.map((item) => item.path).join(", ")}`), { failures });
  for (const field of ["status", "code", "retryAfter"]) {
    const value = Reflect.get(firstError, field);
    if (value !== void 0) {
      Reflect.set(error, field, value);
    }
  }
  return error;
}
var StorageFileApi$1 = class StorageFileApi {
  volcanoAuth;
  bucketName;
  constructor(volcanoAuth, bucketName) {
    this.volcanoAuth = volcanoAuth;
    this.bucketName = bucketName;
  }
  /**
   * Check if user is authenticated
   * @private
   */
  async _checkAuth() {
    await this.volcanoAuth._completeOAuthExchange();
    if (!Boolean(this.volcanoAuth.accessToken)) {
      const exchangeError = this.volcanoAuth._oauthExchangeError;
      return errorResult(exchangeError instanceof Error ? exchangeError : legacyStringDefault(exchangeError, "No active session. Please sign in first."));
    }
    return null;
  }
  /**
   * Build a storage URL for the given path
   * @private
   */
  _buildUrl(path) {
    return buildStorageUrl(this.volcanoAuth.apiUrl, this.bucketName, this._encodePath(path));
  }
  /**
   * Encode a storage path for use in URLs
   * @private
   */
  _encodePath(path) {
    return encodeStoragePath(path);
  }
  /**
   * Make an authenticated storage request
   * @private
   */
  async _storageRequest(url, options = {}) {
    return storageRequest((requestUrl, requestOptions) => fetchWithAuthRetry(this.volcanoAuth, requestUrl, requestOptions), url, options);
  }
  /**
   * Upload a file to the bucket
   */
  async upload(path, fileBody, options = {}) {
    const authError = await this._checkAuth();
    if (authError !== null) {
      return authError;
    }
    return uploadWithFile(this, path, fileBody, options);
  }
  /**
   * Download a file from the bucket
   */
  async download(path, options = {}) {
    const authError = await this._checkAuth();
    if (authError !== null) {
      return authError;
    }
    try {
      const response = await this.volcanoAuth._transport.downloadStorageObject(encodeURIComponent(this.bucketName), this._encodePath(path), this.volcanoAuth._generatedOptions("session", downloadHeaders(options), "blob"));
      return validatedResult({ data: response.data, error: null }, isBlob, "storage download");
    } catch (error) {
      return { data: null, error: error instanceof Error ? error : new Error("Download failed") };
    }
  }
  /**
   * List files in the bucket
   */
  async list(prefix = "", options = {}) {
    const authError = await this._checkAuth();
    if (authError !== null) {
      return { data: null, error: authError.error, nextCursor: null };
    }
    const result = await this._storageRequest(listUrl(this, prefix, options), {
      method: "GET",
      headers: { "Content-Type": "application/json" }
    });
    if (result.error !== null) {
      return { data: null, error: result.error, nextCursor: null };
    }
    return listPayload(result.data);
  }
  /**
   * Delete one or more files from the bucket
   */
  async remove(paths) {
    const authError = await this._checkAuth();
    if (authError !== null) {
      return authError;
    }
    const { deleted, failures } = await deletePaths(this, paths);
    const first = failures[0];
    if (first !== void 0) {
      return { data: { deleted }, error: removeError(failures, first.error) };
    }
    return { data: { deleted }, error: null };
  }
  /**
   * Move/rename a file within the bucket
   */
  async move(fromPath, toPath) {
    const authError = await this._checkAuth();
    if (authError !== null) {
      return authError;
    }
    return validatedResult(await this._storageRequest(`${this.volcanoAuth.apiUrl}/storage/${encodeURIComponent(this.bucketName)}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: fromPath, to: toPath })
    }), isStorageObject, "storage move");
  }
  /**
   * Copy a file within the bucket
   */
  async copy(fromPath, toPath) {
    const authError = await this._checkAuth();
    if (authError !== null) {
      return authError;
    }
    return validatedResult(await this._storageRequest(`${this.volcanoAuth.apiUrl}/storage/${encodeURIComponent(this.bucketName)}/copy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from: fromPath, to: toPath })
    }), isStorageObject, "storage copy");
  }
  /**
   * Get the public URL for a file (only works for files with is_public=true)
   */
  getPublicUrl(path) {
    return storagePublicUrl(this.volcanoAuth.apiUrl, this.bucketName, this.volcanoAuth.anonKey, path);
  }
  /**
   * Update the visibility (public/private) of a file
   */
  async updateVisibility(path, isPublic) {
    const authError = await this._checkAuth();
    if (authError !== null) {
      return authError;
    }
    return validatedResult(await this._storageRequest(`${this._buildUrl(path)}/visibility`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_public: isPublic })
    }), isStorageObject, "storage visibility");
  }
  // ========================================================================
  // Resumable Upload Methods
  // ========================================================================
  async createUploadSession(path, options) {
    const authError = await this._checkAuth();
    if (authError !== null) {
      return authError;
    }
    if (options === null || options === void 0 || !Boolean(options.totalSize)) {
      return errorResult("totalSize is required");
    }
    return validatedResult(await this._storageRequest(this._buildUrl(path), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(uploadSessionBody(path, options))
    }), isUploadSession, "upload session creation");
  }
  async uploadPart(path, sessionId, partNumber, partData) {
    const authError = await this._checkAuth();
    if (authError !== null) {
      return authError;
    }
    return validatedResult(await this._storageRequest(this._buildUrl(path), {
      method: "PUT",
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Upload-Session": sessionId,
        "X-Part-Number": String(partNumber)
      },
      body: partData
    }), isUploadPart, "upload part");
  }
  async completeUploadSession(path, sessionId) {
    const authError = await this._checkAuth();
    if (authError !== null) {
      return authError;
    }
    return validatedResult(await this._storageRequest(this._buildUrl(path), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Upload-Session": sessionId,
        "X-Upload-Complete": "true"
      },
      body: JSON.stringify({})
    }), isCompletedUpload, "completed upload");
  }
  async getUploadSession(path, sessionId) {
    const authError = await this._checkAuth();
    if (authError !== null) {
      return authError;
    }
    return validatedResult(await this._storageRequest(this._buildUrl(path), {
      method: "GET",
      headers: { "X-Upload-Session": sessionId }
    }), isUploadSessionStatus, "upload session status");
  }
  async abortUploadSession(path, sessionId) {
    const authError = await this._checkAuth();
    if (authError !== null) {
      return { error: authError.error };
    }
    const result = await this._storageRequest(this._buildUrl(path), {
      method: "DELETE",
      headers: { "X-Upload-Session": sessionId }
    });
    return { error: result.error };
  }
  async uploadResumable(path, fileBody, options = {}) {
    return validatedResult(await uploadResumable(this, path, fileBody, options), isCompletedUpload, "resumable upload");
  }
};
function requiredField(value, name2) {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Auth response must be an object");
  }
  return Reflect.get(value, name2);
}
function optionalField(value, name2) {
  return typeof value === "object" && value !== null ? Reflect.get(value, name2) : void 0;
}
function optionalStringField(value, name2) {
  const field = optionalField(value, name2);
  if (field === void 0 || field === null) {
    return null;
  }
  if (typeof field !== "string") {
    throw new TypeError(`Auth response ${name2} must be a string`);
  }
  return field;
}
function optionalTokenField(value, name2) {
  const field = optionalField(value, name2);
  if (field === void 0) {
    return void 0;
  }
  if (typeof field !== "string") {
    throw new TypeError(`Auth response ${name2} must be a string`);
  }
  return field;
}
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}
function validateCredentials(session) {
  if (!isNonEmptyString(session["access_token"])) {
    return new TypeError("Session access_token must be a non-empty string");
  }
  if (!isNonEmptyString(session["refresh_token"])) {
    return new TypeError("Session refresh_token must be a non-empty string");
  }
  return null;
}
function validateUser(user) {
  if (!isObject(user)) {
    return new TypeError("Session user must be an object");
  }
  if (!isNonEmptyString(user["id"])) {
    return new TypeError("Session user ID must be a non-empty string");
  }
  return validateAuthUser(user);
}
function isUserStatus(value) {
  return value === "active" || value === "banned" || value === "deleted";
}
function isJsonScalar$1(value) {
  return value === null || typeof value === "string" || typeof value === "boolean" || Number.isFinite(value);
}
function isJsonRecord(value) {
  if (!isObject(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function isJsonValue$1(value) {
  if (isJsonScalar$1(value)) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue$1);
  }
  return isJsonRecord(value) && Object.values(value).every(isJsonValue$1);
}
function isUserMetadata(value) {
  return isJsonRecord(value) && Object.values(value).every(isJsonValue$1);
}
function optionalStringError(user) {
  for (const name2 of ["project_id", "avatar_url", "last_sign_in_at", "created_at", "updated_at"]) {
    if (Object.hasOwn(user, name2) && typeof user[name2] !== "string") {
      return new TypeError(`Auth user ${name2} must be a string`);
    }
  }
  return null;
}
function optionalMetadataError(user) {
  for (const name2 of ["user_metadata", "app_metadata"]) {
    if (Object.hasOwn(user, name2) && !isUserMetadata(user[name2])) {
      return new TypeError(`Auth user ${name2} must be JSON metadata`);
    }
  }
  return null;
}
function optionalBooleanError(user) {
  if (Object.hasOwn(user, "email_confirmed") && typeof user["email_confirmed"] !== "boolean") {
    return new TypeError("Auth user email_confirmed must be a boolean");
  }
  return null;
}
function optionalNullableStringError(user) {
  if (Object.hasOwn(user, "banned_until") && user["banned_until"] !== null && typeof user["banned_until"] !== "string") {
    return new TypeError("Auth user banned_until must be a string or null");
  }
  return null;
}
function optionalStatusError(user) {
  if (Object.hasOwn(user, "status") && !isUserStatus(user["status"])) {
    return new TypeError("Auth user status must be active, banned, or deleted");
  }
  return null;
}
function optionalUserError(user) {
  return optionalStatusError(user) ?? optionalBooleanError(user) ?? optionalNullableStringError(user) ?? optionalStringError(user) ?? optionalMetadataError(user);
}
function validateAuthUser(user) {
  if (!isObject(user)) {
    return new TypeError("Auth user must be an object");
  }
  if (!isNonEmptyString(user["id"])) {
    return new TypeError("Auth user ID must be a non-empty string");
  }
  if (typeof user["email"] !== "string") {
    return new TypeError("Auth user email must be a string");
  }
  return optionalUserError(user);
}
function assertAuthUser(user) {
  const error = validateAuthUser(user);
  if (error !== null) {
    throw error;
  }
}
function assertOptionalRefreshToken(data) {
  if (Object.hasOwn(data, "refresh_token") && data["refresh_token"] !== void 0) {
    if (!isNonEmptyString(data["refresh_token"])) {
      throw new TypeError("Auth refresh_token must be a non-empty string");
    }
  }
}
function assertExpiresIn(data) {
  if (!Number.isInteger(data["expires_in"])) {
    throw new TypeError("Auth expires_in must be an integer");
  }
}
function assertAuthTokenResponse(data) {
  if (!isObject(data)) {
    throw new TypeError("Auth token response must be an object");
  }
  if (!isNonEmptyString(data["access_token"])) {
    throw new TypeError("Auth access_token must be a non-empty string");
  }
  assertOptionalRefreshToken(data);
  assertExpiresIn(data);
  assertAuthUser(data["user"]);
}
function validateCompleteSession(session) {
  if (!isObject(session)) {
    return new TypeError("Session must be an object");
  }
  return validateCredentials(session) ?? validateUser(session["user"]);
}
function validateOAuthSession(session) {
  if (!isObject(session)) {
    return new TypeError("Session must be an object");
  }
  if (!isNonEmptyString(session["access_token"])) {
    return new TypeError("Session access_token must be a non-empty string");
  }
  const refreshToken = session["refresh_token"];
  if (refreshToken !== void 0 && !isNonEmptyString(refreshToken)) {
    return new TypeError("Session refresh_token must be a non-empty string");
  }
  return validateUser(session["user"]);
}
function assertCompleteSession(session) {
  const error = validateCompleteSession(session);
  if (error !== null) {
    throw error;
  }
}
function sanitizeProvider(provider) {
  if (typeof provider !== "string" || !/^[a-z0-9-]+$/.test(provider)) {
    throw new Error("Provider must be a non-empty string containing only lowercase letters, numbers, and hyphens");
  }
}
function cloneJsonValue(value) {
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(value);
  }
  const serialized = JSON.stringify(value);
  const copied = JSON.parse(serialized);
  return copied;
}
async function signUp(host, options) {
  const { email, password, metadata = {} } = options;
  const result = await host._anonFetch("/auth/signup", {
    method: "POST",
    body: JSON.stringify({ email, password, user_metadata: metadata })
  });
  if (result.ok !== true) {
    return {
      user: null,
      session: null,
      confirmationRequired: false,
      message: null,
      error: result.error
    };
  }
  return finishSignUp(host, options, result.data);
}
async function finishSignUp(host, options, data) {
  const confirmationRequired = requiredField(data, "confirmation_required");
  if (typeof confirmationRequired !== "boolean") {
    throw new TypeError("Auth response confirmation_required must be a boolean");
  }
  const message = optionalStringField(data, "message");
  if (options.signInWhenAllowed === true && !confirmationRequired) {
    const signedIn = await host.signIn({ email: options.email, password: options.password });
    return {
      user: signedIn.user,
      session: signedIn.session,
      confirmationRequired,
      message,
      error: signedIn.error
    };
  }
  return { user: null, session: null, confirmationRequired, message, error: null };
}
async function signIn(host, { email, password }) {
  const expectedGeneration = host._sessionGeneration;
  let response;
  try {
    response = await host._transport.authSignin({ email, password }, host._generatedOptions("anon"));
  } catch (error) {
    return {
      user: null,
      session: null,
      error: error instanceof Error ? error : new Error("Sign in failed")
    };
  }
  if (response.data === void 0) {
    throw new TypeError("Sign in returned no session");
  }
  assertAuthTokenResponse(response.data);
  if (!host._setSession(response.data, expectedGeneration)) {
    return { user: null, session: null, error: new AuthSessionChangedError() };
  }
  return {
    user: response.data.user,
    session: {
      access_token: response.data.access_token,
      refresh_token: response.data.refresh_token,
      expires_in: response.data.expires_in
    },
    error: null
  };
}
function getSession(host) {
  if (host.accessToken === null || host.accessToken === "") {
    return Promise.resolve({ data: { session: null }, error: null });
  }
  const user = cloneJsonValue(host.currentUser);
  if (user !== null) {
    assertAuthUser(user);
  }
  return Promise.resolve({
    data: {
      session: {
        access_token: host.accessToken,
        refresh_token: host.refreshToken,
        user
      }
    },
    error: null
  });
}
function setSession$1(host, session) {
  let ownedSession;
  try {
    ownedSession = cloneJsonValue(session);
  } catch {
    return Promise.resolve({
      data: { session: null },
      error: new TypeError("Session must be cloneable")
    });
  }
  const validationError = validateCompleteSession(ownedSession);
  if (validationError !== null) {
    return Promise.resolve({ data: { session: null }, error: validationError });
  }
  assertCompleteSession(ownedSession);
  host._adoptSessionInMemory(ownedSession);
  return host.getSession();
}
function isUserResponseCurrent(host, context, user) {
  const currentId = host.currentUser?.id;
  return host._isAuthContextCurrent(context) && (!Boolean(currentId) || user.id === currentId);
}
function onAuthStateChange(host, callback) {
  host._authCallbacks.push(callback);
  try {
    callback(host.currentUser);
  } catch (error) {
    console.error("[VolcanoAuth] Error in auth state callback:", error);
  }
  return () => {
    host._authCallbacks = host._authCallbacks.filter((registered) => registered !== callback);
  };
}
async function getUser(host) {
  const adoptedFromUrl = host._consumeSessionFromUrl();
  const { result, context } = await host._authFetchWithContext("/auth/user");
  if (result.ok !== true) {
    return { user: null, error: result.error };
  }
  const user = requiredField(result.data, "user");
  assertAuthUser(user);
  if (!isUserResponseCurrent(host, context, user)) {
    return { user: null, error: new AuthSessionChangedError() };
  }
  host.currentUser = user;
  if (adoptedFromUrl || host._pendingUrlAuthNotify) {
    host._pendingUrlAuthNotify = false;
    host._notifyAuthCallbacks(user);
  }
  return { user, error: null };
}
async function updateUser(host, options) {
  const { result, context } = await host._authFetchWithContext("/auth/user", () => {
    const { password, metadata } = options;
    return { method: "PUT", body: JSON.stringify({ password, user_metadata: metadata }) };
  });
  if (result.ok !== true) {
    return { user: null, error: result.error };
  }
  const user = requiredField(result.data, "user");
  assertAuthUser(user);
  if (!isUserResponseCurrent(host, context, user)) {
    return { user: null, error: new AuthSessionChangedError() };
  }
  host.currentUser = user;
  return { user, error: null };
}
async function signInAnonymously(host, metadata) {
  const expectedGeneration = host._sessionGeneration;
  const result = await host._anonFetch("/auth/signup-anonymous", {
    method: "POST",
    body: JSON.stringify({ user_metadata: metadata })
  });
  if (result.ok !== true) {
    return { user: null, session: null, error: result.error };
  }
  assertCompleteSession(result.data);
  assertAuthTokenResponse(result.data);
  if (!host._setSession(result.data, expectedGeneration)) {
    return { user: null, session: null, error: new AuthSessionChangedError() };
  }
  return {
    user: result.data.user,
    session: {
      access_token: result.data.access_token,
      refresh_token: result.data.refresh_token,
      expires_in: result.data.expires_in
    },
    error: null
  };
}
function signUpAnonymous(host, metadata) {
  return host.signInAnonymously(metadata);
}
async function convertAnonymous(host, options) {
  const { result, context } = await host._authFetchWithContext("/auth/user/convert-anonymous", () => {
    const { email, password, metadata = {} } = options;
    return {
      method: "POST",
      body: JSON.stringify({ email, password, user_metadata: metadata })
    };
  });
  return adoptedUser(host, context, result);
}
function adoptedUser(host, context, result) {
  if (result.ok !== true) {
    return { user: null, error: result.error };
  }
  if (!host._isAuthContextCurrent(context)) {
    return { user: null, error: new AuthSessionChangedError() };
  }
  const user = requiredField(result.data, "user");
  assertAuthUser(user);
  host.currentUser = user;
  return { user, error: null };
}
async function messageRequest(host, path, body) {
  const result = await host._anonFetch(path, { method: "POST", body: JSON.stringify(body) });
  return result.ok === true ? { message: optionalStringField(result.data, "message"), error: null } : { message: null, error: result.error };
}
function confirmEmail(host, token) {
  return messageRequest(host, "/auth/confirm", { token });
}
function resendConfirmation(host, email) {
  return messageRequest(host, "/auth/resend-confirmation", { email });
}
function forgotPassword(host, email) {
  return messageRequest(host, "/auth/forgot-password", { email });
}
function resetPasswordForEmail(host, email) {
  return host.forgotPassword(email);
}
function resetPassword(host, { token, newPassword }) {
  return messageRequest(host, "/auth/reset-password", { token, new_password: newPassword });
}
async function requestEmailChange(host, newEmail) {
  const { result, context } = await host._authFetchWithContext("/auth/user/change-email", () => ({
    method: "POST",
    body: JSON.stringify({ new_email: newEmail })
  }));
  if (result.ok !== true) {
    return { message: null, newEmail: null, error: result.error };
  }
  if (!host._isAuthContextCurrent(context)) {
    return { message: null, newEmail: null, error: new AuthSessionChangedError() };
  }
  return {
    message: optionalStringField(result.data, "message"),
    newEmail: optionalStringField(result.data, "new_email"),
    emailChangeToken: optionalTokenField(result.data, "email_change_token"),
    error: null
  };
}
async function confirmEmailChange(host, emailChangeToken) {
  const { result, context } = await host._authFetchWithContext("/auth/user/confirm-email-change", () => ({
    method: "POST",
    body: JSON.stringify({ email_change_token: emailChangeToken })
  }));
  return adoptedUser(host, context, result);
}
async function cancelEmailChange(host) {
  const { result, context } = await host._authFetchWithContext("/auth/user/cancel-email-change", {
    method: "DELETE"
  });
  if (result.ok !== true) {
    return { message: null, error: result.error };
  }
  if (!host._isAuthContextCurrent(context)) {
    return { message: null, error: new AuthSessionChangedError() };
  }
  return { message: optionalStringField(result.data, "message"), error: null };
}
function isBrowser() {
  const environment = globalThis;
  return environment.window?.document !== void 0;
}
var stateKey = "volcano_auth_state";
var redirectKey = "volcano_auth_redirect_url";
var authHashKeys = /* @__PURE__ */ new Set([
  "access_token",
  "refresh_token",
  "token_type",
  "expires_in",
  "state",
  "error",
  "error_description"
]);
var OAUTH_RESPONSE_QUERY_KEYS = /* @__PURE__ */ new Set([
  "code",
  "state",
  "error",
  "error_description",
  "error_uri",
  "iss",
  "vh_state"
]);
function generateAuthStateNonce() {
  const browserCrypto = isBrowser() ? Reflect.get(window, "crypto") : void 0;
  const cryptoObject = browserCrypto ?? Reflect.get(globalThis, "crypto");
  if (!hasRandomValues(cryptoObject)) {
    throw new Error("A Web Crypto implementation (crypto.getRandomValues) is required to start a hosted-auth/OAuth flow.");
  }
  const bytes = new Uint8Array(16);
  cryptoObject.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function hasRandomValues(value) {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "getRandomValues") === "function";
}
function storeAuthState(nonce, redirectUrl = "") {
  if (!isBrowser()) {
    return;
  }
  try {
    window.sessionStorage.setItem(stateKey, nonce);
    if (redirectUrl !== "") {
      window.sessionStorage.setItem(redirectKey, redirectUrl);
    } else {
      window.sessionStorage.removeItem(redirectKey);
    }
  } catch {
  }
}
function takeAuthState() {
  if (!isBrowser()) {
    return null;
  }
  try {
    const nonce = window.sessionStorage.getItem(stateKey);
    window.sessionStorage.removeItem(stateKey);
    return nonce;
  } catch {
    return null;
  }
}
function peekAuthState() {
  if (!isBrowser()) {
    return null;
  }
  try {
    return window.sessionStorage.getItem(stateKey);
  } catch {
    return null;
  }
}
function takeAuthRedirectUrl() {
  if (!isBrowser()) {
    return null;
  }
  try {
    const redirectUrl = window.sessionStorage.getItem(redirectKey);
    window.sessionStorage.removeItem(redirectKey);
    return redirectUrl;
  } catch {
    return null;
  }
}
function peekAuthRedirectUrl() {
  if (!isBrowser()) {
    return null;
  }
  try {
    return window.sessionStorage.getItem(redirectKey);
  } catch {
    return null;
  }
}
function getStorageItem(key) {
  if (!isBrowser()) {
    return null;
  }
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function setStorageItem(key, value) {
  if (!isBrowser()) {
    return;
  }
  try {
    window.localStorage.setItem(key, value);
  } catch {
  }
}
function removeStorageItem(key) {
  if (!isBrowser()) {
    return;
  }
  try {
    window.localStorage.removeItem(key);
  } catch {
  }
}
function removeOAuthResponseParams(callbackUrl, clearHash = true) {
  for (const key of OAUTH_RESPONSE_QUERY_KEYS) {
    callbackUrl.searchParams.delete(key);
  }
  if (clearHash) {
    callbackUrl.hash = "";
  }
}
function stripOAuthQueryFromUrl(callbackUrl) {
  try {
    removeOAuthResponseParams(callbackUrl, false);
    const cleanUrl = (callbackUrl.pathname === "" ? "/" : callbackUrl.pathname) + callbackUrl.search + callbackUrl.hash;
    window.history.replaceState(window.history.state, "", cleanUrl);
  } catch {
  }
}
function hasSessionInUrl() {
  if (!isBrowser()) {
    return false;
  }
  try {
    return window.location.hash.includes("access_token");
  } catch {
    return false;
  }
}
function stripAuthHashFromUrl(params) {
  try {
    if (!Array.from(params.keys()).every((key) => authHashKeys.has(key))) {
      return;
    }
    const history = window.history;
    const location = window.location;
    const cleanUrl = (location.pathname === "" ? "/" : location.pathname) + location.search;
    history.replaceState(history.state, "", cleanUrl);
  } catch {
  }
}
function presentParam(params, name2) {
  const value = params.get(name2);
  return value !== null && value !== "";
}
function hasOAuthResponse(params) {
  return presentParam(params, "state") && (presentParam(params, "code") || presentParam(params, "error"));
}
function matchingOAuthCallback(storedRedirectUrl) {
  try {
    const callbackUrl = new URL(window.location.href);
    if (!hasOAuthResponse(callbackUrl.searchParams)) {
      return false;
    }
    const expectedUrl = new URL(String(storedRedirectUrl));
    removeOAuthResponseParams(callbackUrl);
    removeOAuthResponseParams(expectedUrl);
    return callbackUrl.toString() === expectedUrl.toString();
  } catch {
    return false;
  }
}
function hasOAuthCallbackInUrl(storedRedirectUrl, hasState) {
  if (!isBrowser() || !hasState) {
    return false;
  }
  return matchingOAuthCallback(storedRedirectUrl);
}
function hasToken$2(token) {
  return token !== null && token !== "";
}
function resolvePath(path) {
  return typeof path === "function" ? path() : path;
}
function resolveOptions(options) {
  return typeof options === "function" ? options() : options;
}
function missingSessionError(host) {
  return host._oauthExchangeError ?? new Error("No active session");
}
function failed$1(error, status = null, data = null) {
  return { ok: false, status, error, data };
}
function stale() {
  const error = new AuthSessionChangedError();
  const result = { data: null, status: error.status, headers: {}, version: null, error };
  return result;
}
async function authFetchWithContext(host, path, options = {}) {
  if (host._oauthExchangePromise !== null) {
    await host._completeOAuthExchange();
  }
  const context = host._captureAuthContext();
  if (!hasToken$2(context.accessToken)) {
    return { result: failed$1(missingSessionError(host)), context };
  }
  const requestPath = resolvePath(path);
  const requestOptions = resolveOptions(options);
  if (!host._isAuthContextCurrent(context)) {
    return { result: stale(), context };
  }
  return {
    result: await authFetchUrl(host, `${host.apiUrl}${requestPath}`, requestOptions),
    context
  };
}
function headerEntries(source) {
  if (source instanceof Headers) {
    return Array.from(source.entries());
  }
  return Array.isArray(source) ? source : Object.entries(source ?? {});
}
function requestHeaders(token, source) {
  const headers = {
    Authorization: `Bearer ${String(token)}`,
    "Content-Type": "application/json"
  };
  const names = /* @__PURE__ */ new Map([
    ["authorization", "Authorization"],
    ["content-type", "Content-Type"]
  ]);
  for (const [name2, value] of headerEntries(source)) {
    const normalized = name2.toLowerCase();
    const existing = names.get(normalized) ?? name2;
    headers[existing] = value;
    names.set(normalized, existing);
  }
  return headers;
}
async function requestOnce(host, url, options, token) {
  return fetchWithTimeout(url, { ...options, headers: requestHeaders(token, options.headers) }, host.timeout, async (response, signal) => ({ response, data: await safeJsonParse(response, signal) }));
}
function resultFromResponse(response, data, message) {
  return response.ok ? { ok: true, status: response.status, data, error: null } : {
    ok: false,
    status: response.status,
    error: apiRequestError(response, data, message),
    data
  };
}
async function fetchWithRefresh(host, context, url, options) {
  const first = await requestOnce(host, url, options, context.accessToken);
  if (first.response.status !== 401) {
    return resultFromResponse(first.response, first.data);
  }
  const failure2 = resultFromResponse(first.response, first.data, "Session expired");
  if (!hasToken$2(context.refreshToken)) {
    return failure2;
  }
  return retryAfterUnauthorized(host, context, url, options, failure2);
}
async function retryAfterUnauthorized(host, context, url, options, failure2) {
  const refreshed = await host._refreshSessionForContext(context);
  if (AuthRefreshDiscardedError.is(refreshed.error)) {
    return failed$1(refreshed.error, refreshed.error.status);
  }
  if (refreshed.error !== null) {
    return failure2;
  }
  if (!host._isAuthContextCurrent(context)) {
    return failed$1(new AuthRefreshDiscardedError(), 409);
  }
  const second = await requestOnce(host, url, options, host.accessToken);
  return resultFromResponse(second.response, second.data);
}
async function authFetchUrl(host, url, options = {}) {
  const context = host._captureAuthContext();
  try {
    return await fetchWithRefresh(host, context, url, options);
  } catch (error) {
    return failed$1(error instanceof Error ? error : new Error("Request failed"));
  }
}
async function anonFetch(host, path, options = {}) {
  try {
    const response = await fetchWithTimeout(`${host.apiUrl}${path}`, { ...options, headers: requestHeaders(host.anonKey, options.headers) }, host.timeout);
    const data = await safeJsonParse(response);
    return resultFromResponse(response, data);
  } catch (error) {
    return failed$1(error instanceof Error ? error : new Error("Request failed"));
  }
}
function navigate(url) {
  try {
    const location = window.location;
    const assign = Reflect.get(location, "assign");
    if (typeof assign === "function") {
      Reflect.apply(assign, location, [url]);
    } else {
      location.href = url;
    }
  } catch (error) {
    const message = optionalField(error, "message");
    const detail = typeof message === "string" ? message : String(error);
    if (!detail.includes("Not implemented: navigation")) {
      throw error;
    }
  }
}
function oauthRedirect(host, redirectTo, nonce) {
  const target = new URL(host._resolveOAuthRedirectTarget(redirectTo));
  for (const key of OAUTH_RESPONSE_QUERY_KEYS) {
    if (target.searchParams.has(key)) {
      throw new Error(`OAuth redirectTo must not contain the reserved "${key}" query parameter`);
    }
  }
  const redirectURL = target.toString();
  host._storeAuthState(nonce, redirectURL);
  const transport = new URL(redirectURL);
  const separator = transport.search === "" ? "" : "&";
  transport.search = `${transport.search}${separator}vh_state=${encodeURIComponent(nonce)}`;
  return transport.toString();
}
function signInWithOAuth(host, provider, options) {
  sanitizeProvider(provider);
  if (!isBrowser()) {
    throw new Error("OAuth sign-in is only available in browser environment. Use server-side auth flow for SSR.");
  }
  const nonce = host._generateAuthStateNonce();
  const redirect = oauthRedirect(host, options.redirectTo, nonce);
  const oauthUrl = `${host.apiUrl}/auth/oauth/${provider}/authorize?anon_key=${encodeURIComponent(host.anonKey)}&redirect_url=${encodeURIComponent(redirect)}&client_state=${encodeURIComponent(nonce)}&response_mode=code`;
  navigate(oauthUrl);
  return oauthUrl;
}
function resolveOAuthRedirectTarget(redirectTo) {
  if (typeof redirectTo === "string" && redirectTo.trim() !== "") {
    return redirectTo.trim();
  }
  const location = window.location;
  return `${location.origin}${location.pathname}`;
}
function getHostedAuthUrl(host, options) {
  if (!isBrowser()) {
    throw new Error("getHostedAuthUrl is only available in the browser.");
  }
  const projectId = host._resolveProjectIdForHostedAuth(options.projectId);
  const nonce = host._generateAuthStateNonce();
  host._storeAuthState(nonce);
  const url = new URL(`${host.apiUrl}/projects/${projectId}/auth/hosted`);
  url.searchParams.set("anon_key", host.anonKey);
  if (options.action !== void 0 && options.action !== "") {
    url.searchParams.set("action", options.action);
  }
  url.searchParams.set("state", nonce);
  return url.toString();
}
function signInWithHostedAuth(host, options) {
  const url = host.getHostedAuthUrl(options);
  navigate(url);
  return url;
}
function resolveProjectIdForHostedAuth(host, explicitProjectId) {
  if (typeof explicitProjectId === "string" && explicitProjectId.trim() !== "") {
    return explicitProjectId.trim();
  }
  try {
    return extractRequiredProjectIdFromToken(host.anonKey);
  } catch {
    throw new Error("Unable to determine project id for hosted auth. Pass { projectId } to getHostedAuthUrl()/signInWithHostedAuth().");
  }
}
function signInWithProvider(host, provider) {
  return host.signInWithOAuth(provider);
}
function isRecord$6(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function assertLinkResponse(value) {
  if (!isRecord$6(value) || Object.hasOwn(value, "authorization_url") && typeof value["authorization_url"] !== "string") {
    throw new TypeError("OAuth link response must have a string authorization URL when present");
  }
}
function hasValidProviderDates(value) {
  for (const name2 of ["provider", "linked_at", "updated_at"]) {
    if (Object.hasOwn(value, name2) && typeof value[name2] !== "string") {
      return false;
    }
  }
  return true;
}
function isLinkedProvider(value) {
  return isRecord$6(value) && hasValidProviderDates(value);
}
function linkedProviders(value) {
  const providers = optionalField(value, "providers");
  if (providers === void 0 || providers === null) {
    return [];
  }
  if (!Array.isArray(providers) || !providers.every(isLinkedProvider)) {
    throw new TypeError("OAuth providers response must contain valid providers");
  }
  return providers;
}
async function linkOAuthProvider(host, provider) {
  sanitizeProvider(provider);
  const { result, context } = await host._authFetchWithContext(`/auth/oauth/${provider}/link`, {
    method: "POST"
  });
  if (!host._isAuthContextCurrent(context)) {
    return { data: null, error: new AuthSessionChangedError() };
  }
  if (result.ok !== true) {
    return { data: null, error: result.error };
  }
  assertLinkResponse(result.data);
  return { data: result.data, error: null };
}
async function unlinkOAuthProvider(host, provider) {
  sanitizeProvider(provider);
  const { result, context } = await host._authFetchWithContext(`/auth/oauth/${provider}/unlink`, {
    method: "DELETE"
  });
  if (!host._isAuthContextCurrent(context)) {
    return { error: new AuthSessionChangedError() };
  }
  return { error: result.error };
}
async function getLinkedOAuthProviders(host) {
  const { result, context } = await host._authFetchWithContext("/auth/oauth/providers");
  if (!host._isAuthContextCurrent(context)) {
    return { providers: null, error: new AuthSessionChangedError() };
  }
  if (result.ok !== true) {
    return { providers: null, error: result.error };
  }
  return { providers: linkedProviders(result.data), error: null };
}
function failedTokenStatus(error) {
  return { message: null, provider: null, expiresIn: null, error };
}
function tokenString(value, name2) {
  const field = requiredField(value, name2);
  if (field === void 0) {
    return void 0;
  }
  if (typeof field !== "string") {
    throw new TypeError(`OAuth token ${name2} must be a string`);
  }
  return field;
}
function tokenExpiry(value) {
  const field = requiredField(value, "expires_in");
  if (field === void 0) {
    return void 0;
  }
  if (!Number.isInteger(field)) {
    throw new TypeError("OAuth token expires_in must be an integer");
  }
  return Number(field);
}
function tokenStatus(host, response) {
  const { result, context } = response;
  if (!host._isAuthContextCurrent(context)) {
    return failedTokenStatus(new AuthSessionChangedError());
  }
  if (result.ok !== true) {
    return failedTokenStatus(result.error);
  }
  return {
    message: tokenString(result.data, "message"),
    provider: tokenString(result.data, "provider"),
    expiresIn: tokenExpiry(result.data),
    error: null
  };
}
async function refreshOAuthToken(host, provider) {
  sanitizeProvider(provider);
  return tokenStatus(host, await host._authFetchWithContext(`/auth/oauth/${provider}/refresh-token`, { method: "POST" }));
}
async function getOAuthProviderToken(host, provider) {
  sanitizeProvider(provider);
  return tokenStatus(host, await host._authFetchWithContext(`/auth/oauth/${provider}/token`));
}
async function callOAuthAPI(host, provider, params) {
  sanitizeProvider(provider);
  const { result, context } = await host._authFetchWithContext(`/auth/oauth/${provider}/call-api`, () => {
    const { endpoint, method = "GET", body = null } = params;
    return { method: "POST", body: JSON.stringify({ endpoint, method, body }) };
  });
  if (!host._isAuthContextCurrent(context)) {
    return { data: null, error: new AuthSessionChangedError() };
  }
  return result.ok === true ? { data: requiredField(result.data, "data"), error: null } : { data: null, error: result.error };
}
var AuthSessionOperations = class {
  constructor(verified = null) {
    const initial = verified ?? {};
    this.verifiedPair = verified === null ? null : [initial.access_token, initial.refresh_token];
  }
  verifyPair(data) {
    if (this.locallyCleared) {
      return;
    }
    this.verifiedPair = data !== null ? [data.access_token, data.refresh_token] : null;
  }
  clearLocalCredentials() {
    if (this.signingOut !== null) {
      return;
    }
    this.locallyCleared = true;
    this.verifiedPair = null;
  }
  hasVerifiedPair(accessToken, refreshToken) {
    return refreshToken !== null && refreshToken !== "" && this.verifiedPair?.[0] === accessToken && this.verifiedPair[1] === refreshToken;
  }
  refresh(operation) {
    if (this.signingOut !== null || this.locallyCleared) {
      return null;
    }
    this.refreshing ??= Promise.resolve().then(operation).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }
  signOut(operation) {
    if (this.signingOut === null) {
      const refreshing = this.refreshing;
      this.signingOut = Promise.resolve().then(() => operation(refreshing)).finally(() => {
        this.verifyPair(null);
        this.refreshing = null;
        this.signOutSettled = true;
      });
    }
    return this.signingOut;
  }
  pendingSignOut() {
    return this.signOutSettled ? null : this.signingOut;
  }
  verifiedPair = null;
  refreshing = null;
  signingOut = null;
  signOutSettled = false;
  locallyCleared = false;
  refreshClearedSession = false;
};
var accessTokenKey = "volcano_access_token";
var refreshTokenKey = "volcano_refresh_token";
function handoffParams() {
  try {
    const hash = window.location.hash;
    return new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  } catch {
    return null;
  }
}
function stateMatches(expectedNonce, urlState) {
  return expectedNonce !== null && expectedNonce !== "" && urlState === expectedNonce;
}
function nonempty(value) {
  return value !== null && value !== "";
}
function rejectHandoff(host, params) {
  host._urlSessionConsumed = true;
  host._stripAuthHashFromUrl(params);
  return false;
}
function currentHandoff(host) {
  if (host._urlSessionConsumed || !host._hasSessionInUrl()) {
    return null;
  }
  const params = handoffParams();
  if (params === null) {
    return null;
  }
  const accessToken = params.get("access_token");
  if (!nonempty(accessToken)) {
    return null;
  }
  return { params, accessToken };
}
function consumeSessionFromUrl(host) {
  const handoff = currentHandoff(host);
  if (handoff === null) {
    return false;
  }
  const { params, accessToken } = handoff;
  const expectedNonce = host._takeAuthState();
  host._takeAuthRedirectURL();
  if (!stateMatches(expectedNonce, params.get("state"))) {
    return rejectHandoff(host, params);
  }
  host._replaceSessionFromUrl(accessToken, params.get("refresh_token"));
  host._urlSessionConsumed = true;
  host._stripAuthHashFromUrl(params);
  return true;
}
function replaceSessionFromUrl(host, accessToken, refreshToken) {
  host.accessToken = accessToken;
  host.refreshToken = refreshToken === "" ? null : refreshToken;
  host.currentUser = null;
  host._sessionGeneration += 1;
  host._sessionOperations = new AuthSessionOperations();
  host._setStorageItem(accessTokenKey, host.accessToken);
  if (host.refreshToken === null) {
    host._removeStorageItem(refreshTokenKey);
    return;
  }
  host._setStorageItem(refreshTokenKey, host.refreshToken);
}
function queryValue(url, name2) {
  return url.searchParams.get(name2) ?? "";
}
function oauthCallback() {
  try {
    const url = new URL(window.location.href);
    const code = queryValue(url, "code");
    const providerError = queryValue(url, "error");
    const state = queryValue(url, "state");
    if (code === "" && providerError === "" || state === "") {
      return null;
    }
    return {
      url,
      code,
      providerError,
      description: queryValue(url, "error_description"),
      state
    };
  } catch {
    return null;
  }
}
function redirectTarget(stored, callback) {
  return stored === null || stored === "" ? `${callback.url.origin}${callback.url.pathname}${callback.url.search}` : stored;
}
function exchangeFailure(value) {
  return Boolean(value) ? value : new Error("OAuth code exchange failed");
}
function providerFailure(callback) {
  if (callback.providerError === "") {
    return null;
  }
  return new Error(callback.description === "" ? `OAuth provider rejected sign-in: ${callback.providerError}` : callback.description);
}
async function exchangeOAuthCode(host, callback, storedRedirectUrl) {
  const expectedGeneration = host._sessionGeneration;
  const result = await host._anonFetch("/auth/oauth/exchange", {
    method: "POST",
    body: JSON.stringify({
      code: callback.code,
      redirect_url: redirectTarget(storedRedirectUrl, callback)
    })
  });
  if (expectedGeneration !== host._sessionGeneration) {
    return false;
  }
  if (result.ok !== true) {
    host._oauthExchangeError = exchangeFailure(result.error);
    return false;
  }
  const validationError = validateOAuthSession(result.data);
  if (validationError !== null) {
    host._oauthExchangeError = validationError;
    return false;
  }
  return host._setSession(result.data, expectedGeneration);
}
async function consumeOAuthCodeFromUrl(host) {
  const callback = oauthCallback();
  if (callback === null) {
    return false;
  }
  const expectedState = host._takeAuthState();
  const storedRedirectUrl = host._takeAuthRedirectURL();
  host._stripOAuthQueryFromUrl(callback.url);
  if (!stateMatches(expectedState, callback.state)) {
    host._oauthExchangeError = new Error("OAuth callback state did not match");
    return false;
  }
  const failure2 = providerFailure(callback);
  if (failure2 !== null) {
    host._oauthExchangeError = failure2;
    return false;
  }
  return exchangeOAuthCode(host, callback, storedRedirectUrl);
}
async function completeOAuthExchange(host) {
  const pending = host._oauthExchangePromise;
  try {
    await pending;
  } catch (error) {
    host._oauthExchangeError = error instanceof Error ? error : new Error("OAuth code exchange failed");
  } finally {
    if (host._oauthExchangePromise === pending) {
      host._oauthExchangePromise = null;
    }
  }
}
function validateRefreshSource(context) {
  if (!context.operations.hasVerifiedPair(context.accessToken, context.refreshToken) && extractSessionIdFromToken(context.accessToken) === null) {
    throw new Error("Cannot refresh supplied credentials without a session identifier");
  }
}
function validateSessionContinuation(data, context, userId) {
  assertCompleteSession(data);
  const expected = extractSessionIdFromToken(context.accessToken);
  if (expected !== null && !sessionIdsEqual(expected, extractSessionIdFromToken(data.access_token))) {
    throw new Error("Refreshed credentials belong to a different server session");
  }
  if (Boolean(userId) && data.user.id !== userId) {
    throw new Error("Refreshed session belongs to a different user");
  }
}
function sessionIdsEqual(left, right) {
  return typeof left === "string" && typeof right === "string" && left.toLowerCase() === right.toLowerCase();
}
function normalizedError(reason, fallback) {
  return reason instanceof Error ? reason : new Error(fallback);
}
function hasToken$1(token) {
  return token !== null && token !== "";
}
async function signOut(host) {
  if (host._oauthExchangePromise !== null) {
    await host._completeOAuthExchange();
  }
  const context = host._captureAuthContext();
  if (!hasToken$1(context.accessToken) && !hasToken$1(context.refreshToken)) {
    return await context.operations.pendingSignOut() ?? { error: null };
  }
  return context.operations.signOut((refreshing) => signOutCaptured(host, context, refreshing));
}
async function precedingRefresh(refreshing) {
  return refreshing === null ? null : refreshing.catch((error) => ({ ok: false, error }));
}
function credentialsForSignOut(context, preceding) {
  return {
    accessToken: preceding?.ok === true ? preceding.data.access_token : context.accessToken,
    refreshToken: preceding?.ok === true ? preceding.data.refresh_token : context.refreshToken
  };
}
async function logoutError(host, context, refreshing) {
  const preceding = await precedingRefresh(refreshing);
  const { accessToken, refreshToken } = credentialsForSignOut(context, preceding);
  const verified = context.operations.hasVerifiedPair(accessToken, refreshToken);
  const sessionId = extractSessionIdFromToken(context.accessToken);
  if (sessionId !== null && !verified) {
    return revokeAccessSession(host, context, sessionId, preceding);
  }
  if (!hasToken$1(refreshToken)) {
    return null;
  }
  assertUsablePreceding(preceding, verified);
  const result = await host._anonFetch("/auth/logout", {
    method: "POST",
    body: JSON.stringify({ refresh_token: refreshToken })
  });
  return result.error;
}
function assertUsablePreceding(preceding, verified) {
  if (preceding !== null && preceding.ok !== true && !verified) {
    throw preceding.error;
  }
}
function finishSignOut(host, context, error) {
  const hasSessionId = extractSessionIdFromToken(context.accessToken) !== null;
  const cleared = hasSessionId ? host._clearSessionAtGeneration(context.generation) : host._clearSession(context);
  if (cleared) {
    return { error };
  }
  const changed = new AuthSessionChangedError();
  if (Boolean(error)) {
    Object.defineProperty(changed, "cause", { configurable: true, value: error, writable: true });
  }
  return { error: changed };
}
async function signOutCaptured(host, context, refreshing) {
  let error;
  try {
    error = await logoutError(host, context, refreshing);
  } catch (reason) {
    error = normalizedError(reason, "Session revocation failed");
  }
  return finishSignOut(host, context, error === null ? null : normalizedError(error, "Sign out failed"));
}
function removeSession(host, path, credential) {
  return host._anonFetch(path, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${String(credential)}` }
  });
}
async function revokeAccessSession(host, context, sessionId, preceding) {
  const { accessToken } = credentialsForSignOut(context, preceding);
  const path = `/auth/user/sessions/${encodeURIComponent(sessionId)}`;
  let result = await removeSession(host, path, accessToken);
  if (!(result.status === 401 && hasToken$1(context.refreshToken))) {
    return result.error;
  }
  if (preceding !== null) {
    return previousFailure(preceding, result.error);
  }
  const refreshed = await host._fetchSessionRefresh(context);
  if (refreshed.ok !== true) {
    return refreshed.error;
  }
  result = await removeSession(host, path, refreshed.data.access_token);
  return result.error;
}
function previousFailure(preceding, fallback) {
  return Boolean(preceding.error) ? preceding.error : fallback;
}
async function refreshSession(host) {
  await host._completeOAuthExchange();
  const exchangeError = host._oauthExchangeError;
  host._oauthExchangeError = null;
  if (Boolean(exchangeError) && !hasToken$1(host.refreshToken)) {
    return { session: null, error: exchangeError };
  }
  return refreshSessionForContext(host, host._captureAuthContext());
}
async function refreshSessionForContext(host, context) {
  if (!host._isAuthContextCurrent(context)) {
    return { session: null, error: new AuthRefreshDiscardedError() };
  }
  if (context.refreshToken !== host.refreshToken) {
    return { session: null, error: null };
  }
  if (!hasToken$1(context.refreshToken)) {
    return { session: null, error: new Error("No refresh token") };
  }
  try {
    validateRefreshSource(context);
  } catch (error) {
    return { session: null, error: normalizedError(error, "Refresh failed") };
  }
  return performSessionRefresh(host, context);
}
async function fetchSessionRefresh(host, context) {
  const verified = context.operations.hasVerifiedPair(context.accessToken, context.refreshToken);
  context.operations.verifyPair(null);
  const result = await host._anonFetch("/auth/refresh", {
    method: "POST",
    body: JSON.stringify({ refresh_token: context.refreshToken })
  });
  if (result.ok === true) {
    validateSuccessfulRefresh(result, context, expectedUserId(host, context));
    context.operations.verifyPair(result.data);
    return result;
  }
  if (result.status === 429 && verified) {
    context.operations.verifyPair({
      access_token: context.accessToken,
      refresh_token: context.refreshToken
    });
  }
  return result;
}
function validateSuccessfulRefresh(result, context, userId) {
  assertAuthTokenResponse(result.data);
  validateSessionContinuation(result.data, context, userId);
}
function expectedUserId(host, context) {
  if (!host._isAuthContextCurrent(context)) {
    return context.userId;
  }
  return host.currentUser?.id ?? null;
}
async function refreshResult(host, context) {
  const result = await host._fetchSessionRefresh(context);
  if (context.operations.signingOut === null) {
    if (result.ok === true) {
      host._setRefreshedSession(result.data, context);
    } else if (result.status === 401 || result.status === 403) {
      context.operations.refreshClearedSession = host._clearSession(context);
    }
  }
  return result;
}
function settledRefresh(host, context, result) {
  if (result.ok !== true) {
    return { session: null, error: result.error };
  }
  if (!host._isAuthContextCurrent(context) || context.operations.signingOut !== null) {
    return { session: null, error: new AuthRefreshDiscardedError() };
  }
  return {
    session: {
      access_token: result.data.access_token,
      refresh_token: result.data.refresh_token,
      expires_in: result.data.expires_in
    },
    error: null
  };
}
async function performSessionRefresh(host, context) {
  try {
    const refreshing = context.operations.refresh(() => refreshResult(host, context));
    if (refreshing === null) {
      return { session: null, error: new AuthRefreshDiscardedError() };
    }
    return settledRefresh(host, context, await refreshing);
  } catch (error) {
    return {
      session: null,
      error: host._isAuthContextCurrent(context) ? normalizedError(error, "Refresh failed") : new AuthRefreshDiscardedError()
    };
  }
}
var ACCESS_TOKEN_KEY = "volcano_access_token";
var REFRESH_TOKEN_KEY = "volcano_refresh_token";
function captureAuthContext(host) {
  return Object.freeze({
    generation: host._sessionGeneration,
    operations: host._sessionOperations,
    userId: host.currentUser?.id ?? null,
    accessToken: host.accessToken,
    refreshToken: host.refreshToken
  });
}
function adoptSessionInMemory(host, session) {
  host._sessionGeneration += 1;
  host._sessionOperations = new AuthSessionOperations();
  host._oauthExchangeError = null;
  host._pendingUrlAuthNotify = false;
  host.accessToken = session.access_token;
  host.refreshToken = session.refresh_token;
  host.currentUser = session.user;
}
function isAuthContextCurrent(host, context) {
  return context.generation === host._sessionGeneration;
}
function setSession(host, data, expectedGeneration) {
  if (expectedGeneration !== host._sessionGeneration) {
    return false;
  }
  assertAuthUser(data.user);
  host._oauthExchangeError = null;
  host.accessToken = data.access_token;
  host.refreshToken = data.refresh_token ?? null;
  host.currentUser = data.user;
  host._sessionGeneration += 1;
  host._sessionOperations = new AuthSessionOperations(data);
  host._pendingUrlAuthNotify = false;
  host._setStorageItem(ACCESS_TOKEN_KEY, host.accessToken);
  if (host.refreshToken !== null && host.refreshToken !== "") {
    host._setStorageItem(REFRESH_TOKEN_KEY, host.refreshToken);
  } else {
    host._removeStorageItem(REFRESH_TOKEN_KEY);
  }
  host._notifyAuthCallbacks(host.currentUser);
  return true;
}
function setRefreshedSession(host, data, context) {
  if (!host._isAuthContextCurrent(context) || context.refreshToken !== host.refreshToken) {
    return false;
  }
  validateSessionContinuation(data, context, host.currentUser?.id);
  host._oauthExchangeError = null;
  host.accessToken = data.access_token;
  host.refreshToken = data.refresh_token;
  host.currentUser = data.user;
  host._pendingUrlAuthNotify = false;
  host._setStorageItem(ACCESS_TOKEN_KEY, host.accessToken);
  host._setStorageItem(REFRESH_TOKEN_KEY, host.refreshToken);
  host._notifyAuthCallbacks(host.currentUser);
  return true;
}
function clearSession(host, context) {
  if (!host._isAuthContextCurrent(context) || context.refreshToken !== host.refreshToken) {
    return false;
  }
  return host._clearSessionAtGeneration(context.generation);
}
function clearSessionAtGeneration(host, generation) {
  if (generation !== host._sessionGeneration) {
    return false;
  }
  host._oauthExchangeError = null;
  host._sessionOperations.clearLocalCredentials();
  host.accessToken = null;
  host.refreshToken = null;
  host.currentUser = null;
  host._sessionGeneration += 1;
  host._pendingUrlAuthNotify = false;
  host._removeStorageItem(ACCESS_TOKEN_KEY);
  host._removeStorageItem(REFRESH_TOKEN_KEY);
  host._notifyAuthCallbacks(null);
  return true;
}
function notifyAuthCallbacks(host, user) {
  for (const callback of host._authCallbacks.slice()) {
    try {
      callback(user);
    } catch (error) {
      console.error("[VolcanoAuth] Error in auth state callback:", error);
    }
  }
}
var defaultLimit = 20;
var sessionProviders = /* @__PURE__ */ new Set([
  "email",
  "google",
  "github",
  "microsoft",
  "apple",
  "anonymous"
]);
function isRecord$5(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isSessionProvider(value) {
  return sessionProviders.has(value);
}
function hasSessionIdentity(value) {
  return typeof value["id"] === "string" && typeof value["user_id"] === "string" && isSessionProvider(value["provider"]) && typeof value["expires_at"] === "string";
}
function hasSessionState(value) {
  return typeof value["is_active"] === "boolean" && typeof value["is_current"] === "boolean";
}
function hasOptionalSessionFields(value) {
  for (const name2 of [
    "user_agent",
    "ip_address",
    "last_ip_address",
    "last_activity_at",
    "session_started_at",
    "created_at",
    "updated_at"
  ]) {
    if (Object.hasOwn(value, name2) && typeof value[name2] !== "string") {
      return false;
    }
  }
  return true;
}
function isAuthSession(value) {
  return isRecord$5(value) && hasSessionIdentity(value) && hasSessionState(value) && hasOptionalSessionFields(value);
}
function sessionsField(value) {
  const sessions = requiredField(value, "sessions");
  if (sessions === void 0) {
    return void 0;
  }
  if (!Array.isArray(sessions) || !sessions.every(isAuthSession)) {
    throw new TypeError("Auth sessions response must contain valid sessions");
  }
  return sessions;
}
function integerField(value, name2) {
  const field = requiredField(value, name2);
  if (field === void 0) {
    return void 0;
  }
  if (!Number.isInteger(field)) {
    throw new TypeError(`Auth sessions ${name2} must be an integer`);
  }
  return Number(field);
}
function failedSessions(error) {
  return { sessions: null, total: 0, page: 1, limit: defaultLimit, total_pages: 0, error };
}
function sessionsPath(options) {
  const { page = 1, limit = defaultLimit } = options;
  const params = new URLSearchParams();
  if (page > 1) {
    params.set("page", page.toString());
  }
  if (limit !== defaultLimit) {
    params.set("limit", limit.toString());
  }
  return sessionsPathWithQuery(params.toString());
}
function sessionsPathWithQuery(queryString) {
  return `/auth/user/sessions${queryString === "" ? "" : `?${queryString}`}`;
}
async function getSessions(host, options) {
  const { result, context } = await host._authFetchWithContext(() => sessionsPath(options));
  if (!host._isAuthContextCurrent(context)) {
    return failedSessions(new AuthSessionChangedError());
  }
  if (result.ok !== true) {
    return failedSessions(result.error);
  }
  return {
    sessions: sessionsField(result.data),
    total: integerField(result.data, "total"),
    page: integerField(result.data, "page"),
    limit: integerField(result.data, "limit"),
    total_pages: integerField(result.data, "total_pages"),
    error: null
  };
}
function isCurrentSession(context, sessionId) {
  return sessionIdsEqual(extractSessionIdFromToken(context.accessToken), sessionId);
}
function shouldClearCurrent(context, sessionId, result) {
  return isCurrentSession(context, sessionId) && (result.ok === true || result.status === null);
}
function deletedCurrentSession(host, context, result) {
  if (host._clearSessionAtGeneration(context.generation)) {
    return { error: result.error };
  }
  const changed = new AuthSessionChangedError();
  if (result.error !== null) {
    Object.defineProperty(changed, "cause", {
      configurable: true,
      value: result.error,
      writable: true
    });
  }
  return { error: changed };
}
async function deleteSession(host, sessionId) {
  const { result, context } = await host._authFetchWithContext(`/auth/user/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  if (shouldClearCurrent(context, sessionId, result)) {
    return deletedCurrentSession(host, context, result);
  }
  if (result.ok !== true) {
    return { error: result.error };
  }
  return { error: host._isAuthContextCurrent(context) ? null : new AuthSessionChangedError() };
}
async function deleteAllOtherSessions(host) {
  const { result, context } = await host._authFetchWithContext("/auth/user/sessions", {
    method: "DELETE"
  });
  if (result.ok !== true) {
    return { error: result.error };
  }
  return { error: host._isAuthContextCurrent(context) ? null : new AuthSessionChangedError() };
}
var MutationBuilder = class extends FilterBuilder {
  client;
  table;
  databaseName;
  operation;
  values;
  constructor(client, table, databaseName2, operation, values) {
    super();
    this.client = client;
    this.table = table;
    this.databaseName = databaseName2;
    this.operation = operation;
    this.values = values;
  }
  async execute() {
    await this.client._completeOAuthExchange();
    const preflight = this.preflight();
    if (!preflight.ok) {
      return preflight.result;
    }
    try {
      return await this.request(preflight.databaseName);
    } catch (error) {
      return {
        data: null,
        error: mutationError(error, this.operation)
      };
    }
  }
  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }
  preflight() {
    if (this.client.accessToken === null || this.client.accessToken.length === 0) {
      return {
        ok: false,
        result: errorResult(sessionError(this.client._oauthExchangeError))
      };
    }
    const databaseName2 = this.databaseName;
    if (databaseName2 === null || databaseName2.length === 0) {
      return {
        ok: false,
        result: errorResult("Database name not set. Use .database(databaseName) first.")
      };
    }
    return { ok: true, databaseName: databaseName2 };
  }
  async request(databaseName2) {
    const body = {
      table: this.table
    };
    if (this.values !== null) {
      body.values = this.values;
    }
    if (this.filters.length > 0) {
      body.filters = this.filters;
    }
    const response = await fetchWithAuthRetry(this.client, `${this.client.apiUrl}/databases/${encodeURIComponent(databaseName2)}/query/${encodeURIComponent(this.operation)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const result = await safeJsonParse(response);
    if (!response.ok) {
      return errorResult(responseError(result, this.operation));
    }
    return { data: responseField(result, "data"), error: null };
  }
};
function mutationError(error, operation) {
  return error instanceof Error ? error : new Error(`${operation} failed`);
}
function responseError(result, operation) {
  const value = responseField(result, "error");
  if (value instanceof Error) {
    return value;
  }
  return new Error(Boolean(value) ? String(value) : `${operation} failed`);
}
function sessionError(error) {
  if (error instanceof Error) {
    return error;
  }
  return new Error(error !== null && error.length > 0 ? error : "No active session. Please sign in first.");
}
function responseField(result, field) {
  if (result === null || result === void 0) {
    throw new TypeError("Mutation response is null");
  }
  if (typeof result !== "object") {
    return void 0;
  }
  const value = Reflect.get(result, field);
  return value;
}
function durablePathSegments(fields) {
  const segments = /* @__PURE__ */ new Map();
  for (const [field, value] of Object.entries(fields)) {
    const identifier = typeof value === "string" ? value.trim() : "";
    if (identifier.length === 0) {
      return { error: new Error(`${field} must be a non-empty string`) };
    }
    segments.set(field, encodeURIComponent(identifier));
  }
  return { segments: Object.fromEntries(segments) };
}
function isDurableStatus(value) {
  return (/* @__PURE__ */ new Set([
    "pending",
    "running",
    "succeeded",
    "failed",
    "timed_out",
    "stopped",
    "unknown"
  ])).has(value);
}
function isRecord$4(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function optionalString$3(value) {
  return value === void 0 || typeof value === "string";
}
function optionalBoolean(value) {
  return value === void 0 || typeof value === "boolean";
}
function isExecutionIdentity(value) {
  return typeof value["id"] === "string" && typeof value["function_id"] === "string" && typeof value["name"] === "string" && isDurableStatus(value["status"]);
}
function isExecutionState(value) {
  return typeof value["region"] === "string" && typeof value["created_at"] === "string" && optionalString$3(value["completed_at"]) && optionalBoolean(value["result_expired"]);
}
function isExecutionError(value) {
  return isRecord$4(value) && optionalString$3(value["type"]) && optionalString$3(value["message"]);
}
function isDurableExecution(value) {
  return isRecord$4(value) && isExecutionIdentity(value) && isExecutionState(value) && (value["error"] === void 0 || isExecutionError(value["error"]));
}
function isPageMetadata(value) {
  return typeof value["page"] === "number" && typeof value["limit"] === "number" && typeof value["total"] === "number" && typeof value["has_more"] === "boolean";
}
function isDurablePage(value) {
  return isRecord$4(value) && Array.isArray(value["data"]) && value["data"].every(isDurableExecution) && isPageMetadata(value);
}
var MAX_EXECUTION_NAME_LENGTH = 255;
var DurableFacade = class {
  client;
  constructor(client) {
    this.client = client;
  }
  async start(functionName, input, options) {
    const path = durablePathSegments({ functionName });
    if (path.error !== void 0) {
      return failure(path.error);
    }
    const executionName = validatedExecutionName(options.executionName);
    if (executionName.error !== null) {
      return failure(executionName.error);
    }
    await this.client._completeOAuthExchange();
    const mode = credentialMode(this.client._captureAuthContext().accessToken);
    return durableResult("Failed to start durable execution", isDurableExecution, () => this.client._transport.startDurableExecutionFromApplication(path.segments.functionName, input, this.client._generatedOptions(mode, executionHeaders(executionName.name))));
  }
  async get(projectId, functionName, executionId) {
    const path = durablePathSegments({ projectId, functionName, executionId });
    if (path.error !== void 0) {
      return failure(path.error);
    }
    const sessionError2 = await ownerSession(this.client);
    if (sessionError2 !== null) {
      return failure(sessionError2);
    }
    return durableResult("Failed to read durable execution", isDurableExecution, () => this.client._transport.getDurableExecution(path.segments.projectId, path.segments.functionName, path.segments.executionId, this.client._generatedOptions("session")));
  }
  async list(projectId, functionName, options) {
    const path = durablePathSegments({ projectId, functionName });
    if (path.error !== void 0) {
      return failure(path.error);
    }
    const sessionError2 = await ownerSession(this.client);
    if (sessionError2 !== null) {
      return failure(sessionError2);
    }
    return durableResult("Failed to list durable executions", isDurablePage, () => this.client._transport.listDurableExecutions(path.segments.projectId, path.segments.functionName, listParams(options), this.client._generatedOptions("session")));
  }
  async stop(projectId, functionName, executionId) {
    const path = durablePathSegments({ projectId, functionName, executionId });
    if (path.error !== void 0) {
      return failure(path.error);
    }
    const sessionError2 = await ownerSession(this.client);
    if (sessionError2 !== null) {
      return failure(sessionError2);
    }
    return durableResult("Failed to stop durable execution", isDurableExecution, () => this.client._transport.stopDurableExecution(path.segments.projectId, path.segments.functionName, path.segments.executionId, this.client._generatedOptions("session")));
  }
};
function failure(error) {
  return { data: null, status: null, error };
}
function validatedExecutionName(value) {
  if (value === void 0) {
    return { name: null, error: null };
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    return {
      name: null,
      error: new Error("executionName must be a non-empty string when provided")
    };
  }
  if (value.trim().length > MAX_EXECUTION_NAME_LENGTH) {
    return {
      name: null,
      error: new Error(`executionName must be at most ${String(MAX_EXECUTION_NAME_LENGTH)} characters`)
    };
  }
  return { name: value.trim(), error: null };
}
function credentialMode(token) {
  return token === null || token.length === 0 ? "anon" : "session";
}
function executionHeaders(name2) {
  return name2 === null ? void 0 : { "X-Volcano-Execution-Name": name2 };
}
function listParams(options) {
  const params = {};
  if (options.status !== void 0) {
    params.status = options.status;
  }
  if (options.page !== void 0) {
    params.page = options.page;
  }
  if (options.limit !== void 0) {
    params.limit = options.limit;
  }
  return params;
}
async function ownerSession(client) {
  await client._completeOAuthExchange();
  if (client.accessToken === null || client.accessToken.length === 0) {
    return client._oauthExchangeError ?? new Error("No active session");
  }
  return null;
}
async function durableResult(message, validate, call) {
  try {
    return responseResult(await call(), message, validate);
  } catch (error) {
    return thrownResult(error, message);
  }
}
function responseResult(response, message, validate) {
  if (!responseHasStatus(response)) {
    throw new Error(message);
  }
  if (!validate(response.data)) {
    throw new TypeError(`Invalid durable response: ${message}`);
  }
  return {
    data: response.data,
    status: response.status,
    error: null
  };
}
function responseHasStatus(response) {
  return typeof response === "object" && response !== null && "status" in response && typeof response.status === "number";
}
function thrownResult(error, message) {
  return {
    data: null,
    status: thrownStatus(error),
    error: error instanceof Error ? error : new Error(message, { cause: error })
  };
}
function thrownStatus(error) {
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return null;
  }
  return typeof error.status === "number" ? error.status : null;
}
async function parseResponseBody(response) {
  if (response == null) {
    return null;
  }
  if (typeof response.text !== "function") {
    return parseJsonResponse(response);
  }
  const bodyText = await response.text();
  if (bodyText === "") {
    return null;
  }
  return parseBodyText(bodyText, hasJsonContentType(response));
}
async function parseJsonResponse(response) {
  const readJson = response.json ?? (() => Promise.resolve(null));
  try {
    return await readJson.call(response);
  } catch {
    return null;
  }
}
function hasJsonContentType(response) {
  const value = getHeaderValue(response, "content-type");
  if (!Boolean(value)) {
    return false;
  }
  if (typeof value !== "string") {
    throw new TypeError("Content-Type header must be a string");
  }
  return value.toLowerCase().includes("application/json");
}
function parseBodyText(body, jsonContentType) {
  const shouldParseJson = jsonContentType || body.startsWith("{") || body.startsWith("[");
  if (!shouldParseJson) {
    return body;
  }
  try {
    const value = JSON.parse(body);
    return value;
  } catch {
    return body;
  }
}
var FUNCTION_INVOKED_HEADER = "x-volcano-function-invoked";
function functionWasDispatched(response) {
  return Boolean(getHeaderValue(response, FUNCTION_INVOKED_HEADER));
}
async function functionInvokeResult(response, dispatched) {
  const versionHeader = getHeaderValue(response, "x-volcano-version");
  const data = await parseResponseBody(response);
  const headers = responseHeadersToObject(response);
  const version = typeof versionHeader === "string" && versionHeader.length > 0 ? versionHeader : null;
  if (!response.ok && !dispatched) {
    const message = platformErrorMessage(data, response.status);
    return {
      data: null,
      status: response.status,
      headers,
      version,
      error: new VolcanoSystemError(message, apiRequestError(response, data, message))
    };
  }
  return { data, status: response.status, headers, version, error: null };
}
function platformErrorMessage(data, status) {
  if (typeof data === "object" && data !== null && "error" in data && Boolean(data.error)) {
    return String(data.error);
  }
  return `Invoke request failed with status ${String(status)}`;
}
function failed(error, status = null) {
  return { data: null, status, headers: {}, version: null, error };
}
function asError(reason, fallback) {
  return reason instanceof Error ? reason : new Error(fallback);
}
function hasToken(token) {
  return token !== null && token.length > 0;
}
function authSessionChangedResult() {
  const error = new AuthSessionChangedError();
  return failed(error, error.status);
}
function snapshotPayload(payload) {
  try {
    return { body: JSON.stringify({ payload }) };
  } catch (reason) {
    return {
      error: new VolcanoSystemError(reason instanceof Error ? reason.message : "Invalid function payload", { cause: reason })
    };
  }
}
async function invokeFunction(host, functionName, payload = {}) {
  if (typeof functionName !== "string" || functionName.length === 0) {
    return failed(new Error("functionName must be a non-empty string"));
  }
  const context = host._captureAuthContext();
  const snapshot = snapshotPayload(payload);
  if ("error" in snapshot) {
    return failed(snapshot.error);
  }
  return new FunctionInvocation(host, functionName, context, snapshot.body).run();
}
var FunctionInvocation = class {
  host;
  functionName;
  requestBody;
  operationContext;
  resolutionContext;
  useAnonKey;
  resolutionToken = null;
  resolvedFunctionId;
  resolvedInvokeUrl;
  dispatched = null;
  constructor(host, functionName, context, requestBody) {
    this.host = host;
    this.functionName = functionName;
    this.requestBody = requestBody;
    this.operationContext = context;
    this.resolutionContext = context;
    this.useAnonKey = !Boolean(context.accessToken);
  }
  async run() {
    if (!this.contextIsAvailable()) {
      return authSessionChangedResult();
    }
    await this.completeOAuthExchange();
    const resolution = await this.initialResolution();
    if (typeof resolution !== "string") {
      return resolution;
    }
    let result = await this.invokeWithCurrentCredential(resolution);
    result = await this.retryDeletedFunction(result);
    return this.finalize(result);
  }
  finalize(result) {
    if (!this.host._isAuthContextCurrent(this.operationContext) && !AuthRefreshDiscardedError.is(result.error)) {
      return authSessionChangedResult();
    }
    return result;
  }
  contextIsAvailable() {
    return this.host._isAuthContextCurrent(this.operationContext) && this.operationContext.operations.pendingSignOut() === null;
  }
  async completeOAuthExchange() {
    if (this.host._oauthExchangePromise !== null) {
      await this.host._completeOAuthExchange();
      this.operationContext = this.host._captureAuthContext();
      this.useAnonKey = !Boolean(this.operationContext.accessToken);
    }
    this.resolutionContext = this.operationContext;
    this.resolutionToken = this.credential(this.resolutionContext);
  }
  credential(context) {
    return this.useAnonKey ? this.host.anonKey : context.accessToken;
  }
  async initialResolution() {
    try {
      await this.resolveFunction();
    } catch (reason) {
      return failed(asError(reason, "Failed to resolve function"));
    }
    try {
      return this.resolveInvokeUrl();
    } catch (reason) {
      return failed(asError(reason, "Invalid function identifier"));
    }
  }
  async resolveFunction() {
    const resolution = await this.host._resolveFunctionIdByName(this.functionName.trim(), {
      authContext: this.resolutionContext,
      token: this.resolutionToken,
      useAnonKey: this.useAnonKey
    });
    this.resolvedFunctionId = resolution.functionId;
    this.resolvedInvokeUrl = resolution.invokeUrl;
    this.resolutionToken = resolution.token;
  }
  resolveInvokeUrl() {
    return this.host._getFunctionInvokeUrl(this.resolvedFunctionId, this.resolvedInvokeUrl);
  }
  async invokeWithCurrentCredential(url) {
    const context = this.host._captureAuthContext();
    if (!this.host._isAuthContextCurrent(this.operationContext)) {
      return authSessionChangedResult();
    }
    return this.invokeOnce(url, !this.useAnonKey, context, this.credential(context));
  }
  async invokeOnce(url, allowRefresh, context, accessToken) {
    if (!hasToken(accessToken) || context.operations.pendingSignOut() !== null) {
      return authSessionChangedResult();
    }
    try {
      return await this.sendInvocation(url, allowRefresh, context, accessToken);
    } catch (reason) {
      return this.transportFailure(reason);
    }
  }
  async sendInvocation(url, allowRefresh, context, accessToken) {
    const { response, dispatched } = await this.request(url, accessToken);
    if (response.status === 401 && allowRefresh && !dispatched) {
      const retry = await this.refreshAndRetry(url, context);
      if (retry !== null) {
        return retry;
      }
    }
    return await functionInvokeResult(response, dispatched);
  }
  async request(url, accessToken) {
    const response = await fetchWithTimeout(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      body: this.requestBody
    }, this.host.timeout);
    const dispatched = functionWasDispatched(response);
    this.dispatched = dispatched;
    return { response, dispatched };
  }
  async refreshAndRetry(url, context) {
    const refreshed = await this.host._refreshSessionForContext(context);
    if (AuthRefreshDiscardedError.is(refreshed.error)) {
      return failed(refreshed.error, refreshed.error.status);
    }
    if (!Boolean(refreshed.error)) {
      if (!this.host._isAuthContextCurrent(context)) {
        const error = new AuthRefreshDiscardedError();
        return failed(error, error.status);
      }
      return this.retryWithFreshCredential(url, context);
    }
    this.captureRefreshClear(context);
    return null;
  }
  async retryWithFreshCredential(url, context) {
    const token = this.host.accessToken;
    if (!hasToken(token) || context.operations.pendingSignOut() !== null) {
      return authSessionChangedResult();
    }
    try {
      const { response, dispatched } = await this.request(url, token);
      return await functionInvokeResult(response, dispatched);
    } catch (reason) {
      return this.transportFailure(reason);
    }
  }
  captureRefreshClear(context) {
    if (context.operations.refreshClearedSession && this.host._sessionOperations === context.operations && this.host._sessionGeneration === context.generation + 1) {
      this.operationContext = this.host._captureAuthContext();
    }
  }
  transportFailure(reason) {
    if (reason instanceof VolcanoSystemError) {
      return failed(reason);
    }
    return failed(new VolcanoSystemError(reason instanceof Error ? reason.message : "Request failed", {
      cause: reason
    }));
  }
  async retryDeletedFunction(result) {
    if (result.status !== 404 || this.dispatched === true) {
      return result;
    }
    if (!this.host._isAuthContextCurrent(this.operationContext)) {
      return authSessionChangedResult();
    }
    this.host._clearFunctionResolveCache(this.functionName.trim(), this.resolutionToken, this.useAnonKey);
    try {
      this.resolutionContext = this.host._captureAuthContext();
      this.resolutionToken = this.credential(this.resolutionContext);
      await this.resolveFunction();
      return await this.invokeWithCurrentCredential(this.resolveInvokeUrl());
    } catch (reason) {
      return failed(asError(reason, "Failed to resolve function"));
    }
  }
};
var DEFAULT_MAX_ENTRIES = 1024;
var PRUNE_INTERVAL_MS = 5e3;
function cachedFunctionResolution(value) {
  if (!isCachedResolution(value)) {
    return null;
  }
  const metadata = value.errorMetadata;
  return {
    expiresAt: value.expiresAt,
    functionId: value.functionId,
    error: value.error,
    ..."invokeUrl" in value ? { invokeUrl: value["invokeUrl"] } : {},
    ...metadata === void 0 ? {} : { errorMetadata: metadata }
  };
}
function isCachedResolution(value) {
  if (!isRecord$3(value)) {
    return false;
  }
  return typeof value["expiresAt"] === "number" && validCacheId(value["functionId"]) && validCacheError(value["error"]) && validCacheMetadata(value["errorMetadata"]);
}
function validCacheMetadata(value) {
  return value === void 0 || isRecord$3(value);
}
function isRecord$3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function validCacheId(value) {
  return typeof value === "string" || value === null;
}
function validCacheError(value) {
  return typeof value === "string" || value === null;
}
function getSharedFunctionResolveState() {
  const shared = globalThis.__VOLCANO_SDK_FUNCTION_RESOLVE_STATE_V1__;
  if (shared !== void 0) {
    return shared;
  }
  const state = {
    cache: /* @__PURE__ */ new Map(),
    inFlight: /* @__PURE__ */ new Map(),
    maxEntries: DEFAULT_MAX_ENTRIES,
    lastPruneAtMs: 0
  };
  globalThis.__VOLCANO_SDK_FUNCTION_RESOLVE_STATE_V1__ = state;
  return state;
}
function functionResolveCacheKey(apiUrl2, functionName, token, useAnonKey) {
  if (useAnonKey) {
    return `${apiUrl2}|anon:${token}|${functionName}`;
  }
  const projectScope = extractRequiredProjectIdFromToken(token);
  return `${apiUrl2}|project:${projectScope}|token:${token}|${functionName}`;
}
function clearFunctionResolveCache(state, cacheKey) {
  state.cache.delete(cacheKey);
  state.inFlight.delete(cacheKey);
}
function cacheExpiry(value) {
  if (typeof value !== "object" || value === null || !("expiresAt" in value)) {
    return null;
  }
  return typeof value.expiresAt === "number" ? value.expiresAt : null;
}
function pruneFunctionResolveCache(state, nowMs = Date.now(), force = false) {
  if (!force && nowMs - state.lastPruneAtMs < PRUNE_INTERVAL_MS) {
    return;
  }
  state.lastPruneAtMs = nowMs;
  const retained = removeExpiredEntries(state, nowMs);
  removeOverflowEntries(state, retained);
}
function removeExpiredEntries(state, nowMs) {
  const retained = [];
  for (const [key, value] of state.cache) {
    const expiresAt = cacheExpiry(value);
    if (expiresAt === null || expiresAt <= nowMs) {
      state.cache.delete(key);
    } else {
      retained.push([key, expiresAt]);
    }
  }
  return retained;
}
function removeOverflowEntries(state, retained) {
  retained.sort((a, b) => a[1] - b[1]);
  const overflowCount = Math.max(0, retained.length - state.maxEntries);
  for (const [key] of retained.slice(0, overflowCount)) {
    state.cache.delete(key);
  }
}
function clearSharedFunctionResolveStateForTests() {
  const state = getSharedFunctionResolveState();
  state.cache.clear();
  state.inFlight.clear();
  state.maxEntries = DEFAULT_MAX_ENTRIES;
  state.lastPruneAtMs = 0;
}
var FUNCTION_HOST_LABEL_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
function sanitizeFunctionIdentifierForHost(identifier) {
  if (typeof identifier !== "string") {
    return null;
  }
  const trimmed = identifier.trim();
  if (!FUNCTION_HOST_LABEL_REGEX.test(trimmed)) {
    return null;
  }
  return trimmed;
}
function functionInvokeUrl(apiUrl2, identifier, resolvedUrl) {
  const hostLabel = sanitizeFunctionIdentifierForHost(identifier);
  if (hostLabel === null) {
    throw new Error("functionId must be DNS-safe: lowercase letters, numbers, hyphens, 1-63 chars");
  }
  return validInvokeUrl(resolvedUrl, apiUrl2) ?? `${apiUrl2}/functions/${encodeURIComponent(hostLabel)}/invoke`;
}
function validInvokeUrl(value, apiUrl2) {
  const parsed = invocationUrl(value);
  if (parsed === null) {
    return null;
  }
  if (parsed.protocol === "https:") {
    return parsed.href;
  }
  return parsed.protocol === "http:" && isPlaintextUrl(apiUrl2) ? parsed.href : null;
}
function invocationUrl(value) {
  if (typeof value !== "string") {
    return null;
  }
  try {
    return new URL(value);
  } catch {
    return null;
  }
}
function isPlaintextUrl(value) {
  return invocationUrl(value)?.protocol === "http:";
}
var NEGATIVE_RESOLVE_TTL_MS = 3e4;
function isResolutionOutcome(value) {
  if (!isRecord$2(value)) {
    return false;
  }
  return validResolvedId(value["functionId"]) && validResolvedError(value["error"]) && validResolvedStatus(value["status"]);
}
function validResolvedId(value) {
  return typeof value === "string" || value === null;
}
function validResolvedError(value) {
  return value instanceof Error || value === null;
}
function validResolvedStatus(value) {
  return typeof value === "number" || value === null;
}
async function resolveFunctionByHttp(client, hostLabel, token, cacheKey) {
  const path = `/functions/resolve?name=${encodeURIComponent(hostLabel)}`;
  const result = await client._anonFetch(path, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` }
  });
  if (result.ok !== true) {
    return failedResolution(client._functionResolveState, cacheKey, result);
  }
  return successfulResolution(client._functionResolveState, cacheKey, result);
}
function failedResolution(state, cacheKey, result) {
  if (result.status === 404) {
    cacheNotFound(state, cacheKey, result);
  }
  return {
    functionId: null,
    error: result.error ?? new Error("Failed to resolve function"),
    status: result.status
  };
}
function cacheNotFound(state, cacheKey, result) {
  state.cache.set(cacheKey, {
    functionId: null,
    // Older bundles share the V1 cache, where failures are strings.
    error: cachedErrorMessage(result.error),
    errorMetadata: {
      status: result.status,
      code: result.error?.code,
      retryAfter: result.error?.retryAfter
    },
    expiresAt: Date.now() + NEGATIVE_RESOLVE_TTL_MS
  });
  pruneFunctionResolveCache(state, Date.now(), true);
}
function successfulResolution(state, cacheKey, result) {
  const payload = validatedPayload(result.data);
  state.cache.set(cacheKey, {
    functionId: payload.functionId,
    invokeUrl: payload.invokeUrl,
    error: null,
    expiresAt: Date.now() + payload.ttlSeconds * 1e3
  });
  pruneFunctionResolveCache(state, Date.now(), true);
  return {
    functionId: payload.functionId,
    invokeUrl: payload.invokeUrl,
    error: null,
    status: result.status
  };
}
function validatedPayload(data) {
  if (!isRecord$2(data)) {
    throw new Error("Resolve response missing valid function_id");
  }
  const record = data;
  return {
    functionId: resolvedId(record),
    invokeUrl: record["invoke_url"],
    ttlSeconds: resolvedTtl(record)
  };
}
function cachedErrorMessage(error) {
  if (error === null || error.message.length === 0) {
    return "function not found";
  }
  return error.message;
}
function resolvedId(record) {
  const functionId = sanitizeFunctionIdentifierForHost(record["function_id"]);
  if (functionId === null) {
    throw new Error("Resolve response missing valid function_id");
  }
  return functionId;
}
function resolvedTtl(record) {
  const ttlSeconds = Number(record["cache_ttl_seconds"]);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error("Resolve response missing valid cache_ttl_seconds");
  }
  return ttlSeconds;
}
function isRecord$2(value) {
  return typeof value === "object" && value !== null;
}
function secureRandomUnit() {
  const buffer = new ArrayBuffer(Uint32Array.BYTES_PER_ELEMENT);
  crypto.getRandomValues(new Uint8Array(buffer));
  return new DataView(buffer).getUint32(0) / 4294967296;
}
var MAX_LEASE_LIFETIME_MS = 90 * 24 * 60 * 60 * 1e3;
function lockRequestStart() {
  return { monotonic: performance.now(), wall: Date.now() };
}
var LeaseClock = class {
  ttlMs;
  absoluteMonotonicDeadline;
  absoluteWallDeadline;
  monotonicDeadline;
  wallDeadline;
  constructor(ttl, startedAt) {
    this.ttlMs = ttl * 1e3;
    this.absoluteMonotonicDeadline = startedAt.monotonic + MAX_LEASE_LIFETIME_MS;
    this.absoluteWallDeadline = startedAt.wall + MAX_LEASE_LIFETIME_MS;
    [this.monotonicDeadline, this.wallDeadline] = this.deadlines(startedAt);
  }
  reset(startedAt) {
    [this.monotonicDeadline, this.wallDeadline] = this.deadlines(startedAt);
  }
  remaining() {
    return Math.max(0, Math.min(this.monotonicDeadline - performance.now(), this.wallDeadline - Date.now()));
  }
  deadlines(startedAt) {
    return [
      Math.min(startedAt.monotonic + this.ttlMs, this.absoluteMonotonicDeadline),
      Math.min(startedAt.wall + this.ttlMs, this.absoluteWallDeadline)
    ];
  }
};
var RENEWAL_REQUEST_BUDGET_MS = 1e3;
var RENEWAL_SAFETY_MARGIN_MS = 1e3;
var UNSAFE_RENEWAL_MESSAGE = "lock renewal returned no safe lease window";
var maxTimerDelayMs = () => 24 * 60 * 60 * 1e3;
function expiryError() {
  return new Error("lock lease expired before renewal completed");
}
var LockSession = class {
  locks;
  key;
  ttl;
  lease;
  random;
  clock;
  controller = new AbortController();
  renewalController = null;
  failure = null;
  stopped = false;
  expiryTimer;
  renewalTimer;
  wakeRenewal = null;
  constructor({ locks, key, ttl, lease, startedAt, random }) {
    this.locks = locks;
    this.key = key;
    this.ttl = ttl;
    this.lease = lease;
    this.random = random;
    this.clock = new LeaseClock(ttl, startedAt);
  }
  async run(callback) {
    let data = null;
    let callbackError = null;
    let releaseError;
    try {
      await this.prepare();
      if (this.failure === null) {
        this.start();
        data = await callback({ signal: this.controller.signal, lease: this.lease });
      }
    } catch (error) {
      callbackError = toError(error);
    } finally {
      releaseError = await this.cleanup();
    }
    return { data, error: this.failure ?? callbackError ?? releaseError };
  }
  async prepare() {
    if (this.renewalDelay() > 0) {
      return;
    }
    this.scheduleExpiry();
    if (this.failure !== null) {
      return;
    }
    await this.renewLease();
  }
  start() {
    this.scheduleExpiry();
    this.continueRenewals();
  }
  continueRenewals() {
    void this.runRenewals().catch((error) => {
      this.markLost(toError(error));
    });
  }
  async runRenewals() {
    if (!this.isActive()) {
      return;
    }
    await this.waitToRenew();
    if (!this.isActive()) {
      return;
    }
    if (await this.renew()) {
      this.continueRenewals();
    }
  }
  isActive() {
    return !this.stopped && this.failure === null;
  }
  renew() {
    return this.renewLease();
  }
  async renewLease() {
    const startedAt = lockRequestStart();
    const controller = new AbortController();
    this.renewalController = controller;
    const renewed = await this.locks.renew(this.key, this.lease, {
      ttl: this.ttl,
      signal: controller.signal
    });
    this.renewalController = null;
    const accepted = this.acceptRenewal(renewed.error, startedAt);
    if (accepted) {
      this.scheduleExpiry();
    }
    return accepted;
  }
  acceptRenewal(error, startedAt) {
    if (this.stopped || this.failure !== null) {
      return false;
    }
    if (error !== null) {
      this.markLost(error);
      return false;
    }
    this.clock.reset(startedAt);
    if (this.renewalDelay() === 0) {
      this.markLost(new Error(UNSAFE_RENEWAL_MESSAGE));
      return false;
    }
    return true;
  }
  waitToRenew() {
    const delay = this.renewalDelay();
    if (delay === 0) {
      this.markLost(new Error(UNSAFE_RENEWAL_MESSAGE));
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.wakeRenewal = resolve;
      this.renewalTimer = setTimeout(resolve, Math.ceil(delay));
    }).finally(() => {
      this.wakeRenewal = null;
      this.renewalTimer = void 0;
    });
  }
  renewalDelay() {
    const baseDelay = Math.min(this.clock.ttlMs / 3, maxTimerDelayMs());
    const remaining = this.clock.remaining();
    if (!Number.isFinite(remaining)) {
      return 0;
    }
    const latestDelay = Math.max(0, remaining - RENEWAL_SAFETY_MARGIN_MS - RENEWAL_REQUEST_BUDGET_MS);
    const jitter = baseDelay * 0.1 * (this.random() * 2 - 1);
    return Math.min(Math.max(0, baseDelay + jitter), latestDelay);
  }
  scheduleExpiry() {
    clearTimeout(this.expiryTimer);
    const remaining = this.clock.remaining();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      this.markLost(expiryError());
      return;
    }
    const delay = Math.min(maxTimerDelayMs(), remaining);
    this.expiryTimer = setTimeout(() => {
      this.checkExpiry();
    }, Math.ceil(delay));
  }
  checkExpiry() {
    if (this.stopped || this.failure !== null) {
      return;
    }
    this.scheduleExpiry();
  }
  markLost(error) {
    if (this.failure !== null || this.stopped) {
      return;
    }
    this.failure = error;
    this.renewalController?.abort(error);
    this.controller.abort(error);
    this.stopTimers();
  }
  async cleanup() {
    if (this.clock.remaining() === 0) {
      this.markLost(expiryError());
    }
    this.stopped = true;
    this.renewalController?.abort();
    this.stopTimers();
    try {
      const released = await this.locks.release(this.key, this.lease);
      return released.error;
    } catch (error) {
      return toError(error);
    }
  }
  stopTimers() {
    clearTimeout(this.expiryTimer);
    clearTimeout(this.renewalTimer);
    this.wakeRenewal?.();
  }
};
function toError(error) {
  return error instanceof Error ? error : new Error(String(error));
}
var MAX_LOCK_TTL_SECONDS = 7776e3;
function validateLockOptions(key, options) {
  validateLockKey(key);
  const ttl = property$2(options, "ttl");
  if (!validTtl(ttl)) {
    throw new RangeError("ttl must be an integer between 5 seconds and 90 days");
  }
  return ttl;
}
function validTtl(ttl) {
  return typeof ttl === "number" && ttl % 1 === 0 && ttl >= 5 && ttl <= MAX_LOCK_TTL_SECONDS;
}
function validateLockKey(key) {
  if (typeof key !== "string" || !/^[a-z0-9][\w.:-]{0,127}$/i.test(key)) {
    throw new TypeError("lock key must match ^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$");
  }
}
function validateLease(key, lease) {
  if (property$2(lease, "key") !== key || !validToken(property$2(lease, "token"))) {
    throw new TypeError("lease must belong to the requested lock and include its token");
  }
}
function validToken(token) {
  return typeof token === "string" && token !== "";
}
function property$2(value, name2) {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return void 0;
  }
  return Reflect.get(value, name2);
}
var CONTENTION_CODES = /* @__PURE__ */ new Set(["lock_held", "lock_ownership_lost"]);
var ProjectLocksApi = class {
  client;
  constructor(client) {
    this.client = client;
  }
  async acquire(key, options) {
    const ttl = validateLockOptions(key, options);
    const token = lockId(options.token);
    const requestId = lockId(options.requestId);
    const lease = { key, token, expiresAt: null, fencingToken: null };
    await this.client._completeOAuthExchange();
    const requestOptions = this.client._generatedOptions("anon", {
      Authorization: `Bearer ${String(this.client.accessToken)}`,
      "X-Volcano-Lock-Token": token,
      "X-Volcano-Request-Id": requestId
    });
    const attempted = await this.tryAcquire(key, ttl, requestOptions);
    if (attempted.response !== null) {
      const fields = leaseFields(attempted.response.data);
      lease.expiresAt = fields.expiresAt;
      lease.fencingToken = fields.fencingToken;
      return { acquired: true, lease, error: null };
    }
    if (isContention(attempted.error)) {
      return { acquired: false, lease: null, error: null };
    }
    return { acquired: false, lease, error: attempted.error };
  }
  async tryAcquire(key, ttl, requestOptions) {
    const first = await this.acquireAttempt(key, ttl, requestOptions);
    if (first.response !== null || !retryable(first.error)) {
      return first;
    }
    return this.acquireAttempt(key, ttl, requestOptions);
  }
  async acquireAttempt(key, ttl, requestOptions) {
    try {
      const response = await this.client._transport.acquireProjectLock(encodeURIComponent(key), { ttl_seconds: ttl }, requestOptions);
      return { response, error: null };
    } catch (error) {
      return {
        response: null,
        error: error instanceof Error ? error : new Error("Lock acquisition failed")
      };
    }
  }
  async renew(key, lease, options) {
    const ttl = validateLockOptions(key, options);
    validateLease(key, lease);
    const result = await this.client._authFetch(`/locks/${encodeURIComponent(key)}/lease`, {
      method: "PATCH",
      headers: {
        "X-Volcano-Lock-Token": lease.token,
        "X-Volcano-Request-Id": lockId(options.requestId)
      },
      body: JSON.stringify({ ttl_seconds: ttl }),
      ...options.signal === void 0 ? {} : { signal: options.signal }
    });
    if (result.ok !== true) {
      return { lease, error: result.error };
    }
    const fields = leaseFields(result.data);
    lease.expiresAt = fields.expiresAt;
    lease.fencingToken = fields.fencingToken ?? lease.fencingToken;
    return { lease, error: null };
  }
  async release(key, lease, options = {}) {
    validateLockKey(key);
    validateLease(key, lease);
    try {
      await this.client._transport.releaseProjectLock(encodeURIComponent(key), this.client._generatedOptions("session", {
        "X-Volcano-Lock-Token": lease.token,
        "X-Volcano-Request-Id": lockId(options.requestId)
      }));
      return { error: null };
    } catch (error) {
      return { error: error instanceof Error ? error : new Error("Lock release failed") };
    }
  }
  async get(key, options = {}) {
    validateLockKey(key);
    const result = await this.client._authFetch(`/locks/${encodeURIComponent(key)}`, {
      method: "GET",
      headers: { "X-Volcano-Request-Id": lockId(options.requestId) }
    });
    if (result.ok !== true) {
      return { state: null, error: result.error };
    }
    return { state: stateFields(result.data), error: null };
  }
  async forceRelease(key, options = {}) {
    validateLockKey(key);
    const result = await this.client._authFetch(`/locks/${encodeURIComponent(key)}`, {
      method: "DELETE",
      headers: { "X-Volcano-Request-Id": lockId(options.requestId) }
    });
    return { error: result.error };
  }
  async withLock(key, options, callback) {
    if (typeof callback !== "function") {
      throw new TypeError("callback must be a function");
    }
    const ttl = validateLockOptions(key, options);
    const startedAt = lockRequestStart();
    const acquired = await this.acquire(key, options);
    if (!acquired.acquired || acquired.lease === null || acquired.error !== null) {
      return { acquired: acquired.acquired, data: null, error: acquired.error };
    }
    const session = new LockSession({
      locks: this,
      key,
      ttl,
      lease: acquired.lease,
      startedAt,
      random: secureRandomUnit
    });
    return { acquired: true, ...await session.run(callback) };
  }
};
function isRecord$1(value) {
  return typeof value === "object" && value !== null;
}
function lockId(value) {
  return typeof value !== "string" || value.length === 0 ? crypto.randomUUID() : value;
}
function leaseFields(value) {
  if (!isRecord$1(value)) {
    throw new TypeError("Lock response has no expiration");
  }
  const expiresAt = value["expires_at"];
  if (typeof expiresAt !== "string") {
    throw new TypeError("Lock response has no expiration");
  }
  return {
    expiresAt,
    fencingToken: optionalNumber(value["fencing_token"], "Lock response has an invalid fencing token")
  };
}
function stateFields(value) {
  if (!isRecord$1(value)) {
    throw new TypeError("Lock state response is not an object");
  }
  return {
    held: value["held"] === true,
    expiresAt: optionalString$2(value["expires_at"], "Lock state has an invalid expiration"),
    fencingToken: optionalNumber(value["fencing_token"], "Lock state has an invalid fencing token")
  };
}
function optionalString$2(value, message) {
  if (value === void 0 || value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new TypeError(message);
  }
  return value;
}
function optionalNumber(value, message) {
  if (value === void 0 || value === null) {
    return null;
  }
  if (typeof value !== "number") {
    throw new TypeError(message);
  }
  return value;
}
function errorStatus(error) {
  const status = Reflect.get(error, "status");
  return typeof status === "number" ? status : null;
}
function retryable(error) {
  const status = errorStatus(error);
  return status === null || status === 503;
}
function isContention(error) {
  const info = Reflect.get(error, "info");
  if (errorStatus(error) !== 409 || !isRecord$1(info)) {
    return false;
  }
  return CONTENTION_CODES.has(info["code"]);
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function optionalString$1(value) {
  return value === void 0 || typeof value === "string";
}
function isJsonScalar(value) {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}
function isJsonValue(value) {
  if (isJsonScalar(value)) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return isRecord(value) && Object.values(value).every(isJsonValue);
}
function isLogResource(value) {
  if (!isRecord(value)) {
    return false;
  }
  const resourceTypes = ["function", "frontend", "database"];
  const type = value["type"];
  return resourceTypes.includes(type) && typeof value["id"] === "string" && optionalString$1(value["name"]);
}
function isLogDeployment(value) {
  return isRecord(value) && typeof value["id"] === "string" && optionalString$1(value["stage"]);
}
function isLogLevel(value) {
  const levels = ["trace", "debug", "info", "warn", "error", "fatal"];
  return levels.includes(value);
}
function isEventCore(value) {
  return typeof value["id"] === "string" && typeof value["timestamp"] === "string" && isJsonValue(value["body"]) && isLogResource(value["resource"]);
}
function isEventDetails(value) {
  return validOptionalLevel(value["level"]) && optionalString$1(value["region"]) && validOptionalDeployment(value["deployment"]) && optionalString$1(value["invocation_id"]);
}
function validOptionalLevel(value) {
  return value === void 0 || isLogLevel(value);
}
function validOptionalDeployment(value) {
  return value === void 0 || isLogDeployment(value);
}
function isLogSearchEvent(value) {
  return isRecord(value) && isEventCore(value) && isEventDetails(value);
}
function isLogSearchResponse(value) {
  return isRecord(value) && Array.isArray(value["data"]) && value["data"].every(isLogSearchEvent) && isSearchPage(value);
}
function isSearchPage(value) {
  return typeof value["limit"] === "number" && typeof value["has_more"] === "boolean" && optionalString$1(value["next_cursor"]);
}
function isCountRecord(value) {
  return isRecord(value) && Object.values(value).every((count) => typeof count === "number");
}
function isActivityCounts(value) {
  return isRecord(value) && isCountRecord(value["levels"]) && isCountRecord(value["regions"]) && isCountRecord(value["resource_ids"]);
}
function isActivityBucket(value) {
  return isRecord(value) && typeof value["start_time"] === "string" && typeof value["end_time"] === "string" && isActivityCounts(value["counts"]) && typeof value["total"] === "number";
}
function isLogActivityResponse(value) {
  return isRecord(value) && Array.isArray(value["data"]) && value["data"].every(isActivityBucket) && typeof value["total"] === "number";
}
function logSearchResult(value) {
  return isLogSearchResponse(value) ? { data: value, error: null } : { data: null, error: new TypeError("Invalid log search response") };
}
function logActivityResult(value) {
  return isLogActivityResponse(value) ? { data: value, error: null } : { data: null, error: new TypeError("Invalid log activity response") };
}
var DEFAULT_API_URL = "https://api.volcano.dev";
var DEFAULT_TIMEOUT_MS = 6e4;
var STORAGE_KEY_ACCESS_TOKEN = "volcano_access_token";
var STORAGE_KEY_REFRESH_TOKEN = "volcano_refresh_token";
var GENERATED_TRANSPORT = {
  acquireProjectLock,
  authSignin,
  downloadStorageObject,
  getDurableExecution,
  listDurableExecutions,
  queryDatabaseSelect: queryDatabaseSelectTransport,
  releaseProjectLock,
  startDurableExecutionFromApplication,
  stopDurableExecution,
  uploadStorageObject
};
function requireAnonKey(anonKey) {
  if (typeof anonKey !== "string" || anonKey === "") {
    throw new Error("anonKey is required. Get your anon key from project settings.");
  }
  if (anonKey.startsWith("sk-") && isBrowser()) {
    throw new Error("[VOLCANO SECURITY ERROR] Service keys (sk-*) cannot be used in client-side code. Service keys bypass Row Level Security and expose your database to unauthorized access. Use an anon key (ak-*) for browser/client-side applications. Service keys should only be used in secure server-side environments. See: https://docs.volcano.hosting/security/keys");
  }
}
function configApiUrl(config) {
  const url = config.apiUrl === "" ? DEFAULT_API_URL : config.apiUrl ?? DEFAULT_API_URL;
  return url.replace(/\/$/, "");
}
function configTimeout(value) {
  return typeof value === "number" && value !== 0 && !Number.isNaN(value) ? value : DEFAULT_TIMEOUT_MS;
}
var VolcanoAuth = class {
  /** @internal */
  apiUrl;
  /** @internal */
  anonKey;
  /** @internal */
  timeout;
  /** @internal */
  _currentDatabaseName;
  /** @internal */
  currentUser;
  /** @internal */
  _sessionGeneration;
  /** @internal */
  _urlSessionConsumed;
  /** @internal */
  _pendingUrlAuthNotify;
  /** @internal */
  _oauthExchangePromise;
  /** @internal */
  _sessionOperations;
  /** @internal */
  _oauthExchangeError;
  /** @internal */
  _authCallbacks;
  /** @internal */
  _functionResolveState;
  /** @internal */
  _transport;
  /** @internal */
  _durableFacade;
  /** @internal */
  accessToken;
  /** @internal */
  refreshToken;
  auth;
  functions;
  durable;
  logs;
  storage;
  locks;
  constructor(config) {
    requireAnonKey(config.anonKey);
    this.apiUrl = configApiUrl(config);
    this.anonKey = config.anonKey;
    this.timeout = configTimeout(config.timeout);
    this._currentDatabaseName = null;
    this.currentUser = null;
    this._sessionGeneration = 0;
    this._urlSessionConsumed = false;
    this._pendingUrlAuthNotify = false;
    this._oauthExchangePromise = null;
    this._sessionOperations = new AuthSessionOperations();
    this._oauthExchangeError = null;
    this._authCallbacks = [];
    this._functionResolveState = getSharedFunctionResolveState();
    this._transport = { ...GENERATED_TRANSPORT, ...config.transportFactory?.(this) };
    this._durableFacade = new DurableFacade(this);
    this.accessToken = null;
    this.refreshToken = null;
    this._initializeCredentials(config);
    this._beginOAuthCallback(config);
    this.auth = {
      signUp: this.signUp.bind(this),
      signIn: this.signIn.bind(this),
      getSession: this.getSession.bind(this),
      setSession: this.setSession.bind(this),
      signOut: this.signOut.bind(this),
      getUser: this.getUser.bind(this),
      updateUser: this.updateUser.bind(this),
      refreshSession: this.refreshSession.bind(this),
      onAuthStateChange: this.onAuthStateChange.bind(this),
      user: () => this.currentUser,
      // Anonymous user methods
      signInAnonymously: this.signInAnonymously.bind(this),
      signUpAnonymous: this.signUpAnonymous.bind(this),
      convertAnonymous: this.convertAnonymous.bind(this),
      // Email confirmation methods
      confirmEmail: this.confirmEmail.bind(this),
      resendConfirmation: this.resendConfirmation.bind(this),
      // Password recovery methods
      resetPasswordForEmail: this.resetPasswordForEmail.bind(this),
      forgotPassword: this.forgotPassword.bind(this),
      resetPassword: this.resetPassword.bind(this),
      // Email change methods
      requestEmailChange: this.requestEmailChange.bind(this),
      confirmEmailChange: this.confirmEmailChange.bind(this),
      cancelEmailChange: this.cancelEmailChange.bind(this),
      // Managed hosted auth pages
      getHostedAuthUrl: this.getHostedAuthUrl.bind(this),
      signInWithHostedAuth: this.signInWithHostedAuth.bind(this),
      // OAuth methods
      signInWithOAuth: this.signInWithOAuth.bind(this),
      signInWithGoogle: this.signInWithGoogle.bind(this),
      signInWithGitHub: this.signInWithGitHub.bind(this),
      signInWithMicrosoft: this.signInWithMicrosoft.bind(this),
      signInWithApple: this.signInWithApple.bind(this),
      linkOAuthProvider: this.linkOAuthProvider.bind(this),
      unlinkOAuthProvider: this.unlinkOAuthProvider.bind(this),
      getLinkedOAuthProviders: this.getLinkedOAuthProviders.bind(this),
      refreshOAuthToken: this.refreshOAuthToken.bind(this),
      getOAuthProviderToken: this.getOAuthProviderToken.bind(this),
      callOAuthAPI: this.callOAuthAPI.bind(this),
      // Session management methods
      getSessions: this.getSessions.bind(this),
      deleteSession: this.deleteSession.bind(this),
      deleteAllOtherSessions: this.deleteAllOtherSessions.bind(this)
    };
    this.functions = {
      invoke: this.invokeFunction.bind(this)
    };
    this.durable = {
      start: this.startDurableExecution.bind(this),
      get: this.getDurableExecution.bind(this),
      list: this.listDurableExecutions.bind(this),
      stop: this.stopDurableExecution.bind(this)
    };
    this.logs = {
      search: this.searchLogs.bind(this),
      activity: this.getLogActivity.bind(this)
    };
    this.storage = {
      from: this.storageBucket.bind(this)
    };
    this.locks = new ProjectLocksApi(this);
  }
  /** @internal */
  _initializeCredentials(config) {
    if (typeof config.accessToken === "string" && config.accessToken !== "") {
      this.accessToken = config.accessToken;
      this.refreshToken = config.refreshToken === "" ? null : config.refreshToken ?? null;
      return;
    }
    this.accessToken = this._getStorageItem(STORAGE_KEY_ACCESS_TOKEN);
    this.refreshToken = this._getStorageItem(STORAGE_KEY_REFRESH_TOKEN);
    this._pendingUrlAuthNotify = this._consumeSessionFromUrl();
  }
  /** @internal */
  _beginOAuthCallback(config) {
    if (typeof config.accessToken === "string" && config.accessToken !== "") {
      return;
    }
    if (!this._hasOAuthCallbackInUrl()) {
      return;
    }
    this._oauthExchangePromise = this._consumeOAuthCodeFromUrl();
    void this._completeOAuthExchange();
  }
  /** @internal */
  async _postProjectLogRequest(projectId, endpoint, request) {
    if (typeof projectId !== "string" || projectId.trim() === "") {
      return { data: null, error: new Error("projectId must be a non-empty string") };
    }
    const result = await this._authFetch(`/projects/${encodeURIComponent(projectId)}/logs/${endpoint}`, {
      method: "POST",
      body: JSON.stringify(Boolean(request) ? request : {})
    });
    if (result.ok !== true) {
      return { data: null, error: result.error };
    }
    return { data: result.data, error: null };
  }
  /** @internal */
  async searchLogs(projectId, request) {
    const result = await this._postProjectLogRequest(projectId, "search", request);
    return result.error === null ? logSearchResult(result.data) : { data: null, error: result.error };
  }
  /** @internal */
  async getLogActivity(projectId, request) {
    const result = await this._postProjectLogRequest(projectId, "activity", request);
    return result.error === null ? logActivityResult(result.data) : { data: null, error: result.error };
  }
  /**
   * Select a storage bucket to perform operations on
   * @param {string} bucketName - The name of the bucket
   * @returns {StorageFileApi} - Storage file API for the bucket
   */
  /** @internal */
  storageBucket(bucketName) {
    return new StorageFileApi$1(this, bucketName);
  }
  /** @internal */
  async _authFetch(path, options = {}) {
    const { result } = await this._authFetchWithContext(path, options);
    return result;
  }
  /** @internal */
  async _authFetchWithContext(path, options = {}) {
    return authFetchWithContext(this, path, options);
  }
  /** @internal */
  async _authFetchUrl(url, fetchOptions = {}) {
    return authFetchUrl(this, url, fetchOptions);
  }
  /** @internal */
  _generatedOptions(volcanoAuthorization, headers, responseType) {
    return {
      volcanoAuthorization,
      volcanoClient: this,
      ...headers === void 0 ? {} : { headers },
      ...responseType === void 0 ? {} : { volcanoResponseType: responseType }
    };
  }
  /** @internal */
  async _generatedFetch(path, options, authorization) {
    const url = `${this.apiUrl}${path}`;
    if (authorization === "anon") {
      const headers = new Headers(options.headers);
      if (!headers.has("Authorization")) {
        headers.set("Authorization", `Bearer ${this.anonKey}`);
      }
      return fetchWithTimeout(url, {
        ...options,
        headers
      }, this.timeout);
    }
    return fetchWithAuthRetry(this, url, options);
  }
  /** @internal */
  _getFunctionInvokeUrl(functionIdentifier, resolvedInvokeUrl) {
    return functionInvokeUrl(this.apiUrl, functionIdentifier, resolvedInvokeUrl);
  }
  /** @internal */
  _functionResolveCacheKey(functionName, token, useAnonKey) {
    return functionResolveCacheKey(this.apiUrl, functionName, token, useAnonKey);
  }
  /** @internal */
  _clearFunctionResolveCache(functionName, token, useAnonKey) {
    const cacheKey = this._functionResolveCacheKey(functionName, token, useAnonKey);
    clearFunctionResolveCache(this._functionResolveState, cacheKey);
  }
  /** @internal */
  async _resolveFunctionIdByName(functionName, options) {
    const hostLabel = sanitizeFunctionIdentifierForHost(functionName);
    if (hostLabel === null) {
      throw new Error("functionName must be DNS-safe: lowercase letters, numbers, hyphens, 1-63 chars");
    }
    const { authContext, token, useAnonKey } = options;
    this._assertCurrentAuthContext(authContext);
    if (token === null) {
      throw new Error("No credential available to resolve function");
    }
    const cacheKey = this._functionResolveCacheKey(hostLabel, token, useAnonKey);
    const cached = this._readFunctionResolveCache(cacheKey, token);
    if (cached !== null) {
      return cached;
    }
    return await this._resolveUncachedFunction(hostLabel, functionName, cacheKey, token, options);
  }
  /** @internal */
  _assertCurrentAuthContext(authContext) {
    if (!this._isAuthContextCurrent(authContext)) {
      throw new AuthSessionChangedError();
    }
  }
  /** @internal */
  _readFunctionResolveCache(cacheKey, token) {
    const now = Date.now();
    pruneFunctionResolveCache(this._functionResolveState, now);
    const rawCached = this._functionResolveState.cache.get(cacheKey);
    const cached = cachedFunctionResolution(rawCached);
    if (cached !== null && cached.expiresAt > now) {
      if (cached.error !== null) {
        throw Object.assign(new Error(cached.error), { status: 404 }, cached.errorMetadata);
      }
      return { functionId: cached.functionId, invokeUrl: cached.invokeUrl, token };
    }
    if (rawCached !== void 0) {
      this._functionResolveState.cache.delete(cacheKey);
    }
    return null;
  }
  /** @internal */
  async _resolveUncachedFunction(hostLabel, functionName, cacheKey, token, options) {
    let pending = this._functionResolveState.inFlight.get(cacheKey);
    const ownsPending = pending === void 0;
    if (pending === void 0) {
      pending = resolveFunctionByHttp(this, hostLabel, token, cacheKey);
      this._functionResolveState.inFlight.set(cacheKey, pending);
    }
    try {
      const outcome = await this._awaitFunctionResolution(pending, options.authContext);
      if (outcome.error !== null) {
        return await this._handleFunctionResolutionError(outcome.error, outcome.status, functionName, options);
      }
      return { functionId: outcome.functionId, invokeUrl: outcome.invokeUrl, token };
    } finally {
      if (ownsPending && this._functionResolveState.inFlight.get(cacheKey) === pending) {
        this._functionResolveState.inFlight.delete(cacheKey);
      }
    }
  }
  /** @internal */
  async _awaitFunctionResolution(pending, authContext) {
    let outcome;
    try {
      outcome = await pending;
    } catch (error) {
      this._assertCurrentAuthContext(authContext);
      throw error;
    }
    this._assertCurrentAuthContext(authContext);
    if (!isResolutionOutcome(outcome)) {
      throw new Error("Invalid in-flight function resolution");
    }
    return outcome;
  }
  /** @internal */
  async _handleFunctionResolutionError(error, status, functionName, options) {
    if (status === 401 && !options.useAnonKey && options.allowRefresh !== false) {
      return await this._retryFunctionResolution(functionName, options, error);
    }
    throw error;
  }
  /** @internal */
  async _retryFunctionResolution(functionName, options, cause) {
    const sessionExpiredError = Object.assign(new Error("Session expired"), cause);
    if (options.authContext.refreshToken === null || options.authContext.refreshToken === "") {
      throw sessionExpiredError;
    }
    const refreshed = await this._refreshSessionForContext(options.authContext);
    if (AuthRefreshDiscardedError.is(refreshed.error)) {
      throw refreshed.error;
    }
    this._assertRefreshSucceeded(refreshed.error, sessionExpiredError);
    if (!this._isAuthContextCurrent(options.authContext)) {
      throw new AuthRefreshDiscardedError();
    }
    const refreshedContext = this._captureAuthContext();
    return await this._resolveFunctionIdByName(functionName, {
      authContext: refreshedContext,
      token: refreshedContext.accessToken,
      useAnonKey: options.useAnonKey,
      allowRefresh: false
    });
  }
  /** @internal */
  _assertRefreshSucceeded(error, sessionExpiredError) {
    if (error !== null) {
      throw sessionExpiredError;
    }
  }
  /** @internal */
  async _anonFetch(path, options = {}) {
    return anonFetch(this, path, options);
  }
  from(table) {
    return new QueryBuilder$1(this, table, this._currentDatabaseName);
  }
  database(databaseName2) {
    this._currentDatabaseName = databaseName2;
    return this;
  }
  insert(table, values) {
    return new MutationBuilder(this, table, this._currentDatabaseName, "insert", values);
  }
  update(table, values) {
    return new MutationBuilder(this, table, this._currentDatabaseName, "update", values);
  }
  delete(table) {
    return new MutationBuilder(this, table, this._currentDatabaseName, "delete", null);
  }
  /** @internal */
  async signUp(options) {
    return signUp(this, options);
  }
  /** @internal */
  async signIn(options) {
    return signIn(this, options);
  }
  /** @internal */
  getSession() {
    return getSession(this);
  }
  /** @internal */
  setSession(session) {
    return setSession$1(this, session);
  }
  /** @internal */
  async signOut() {
    return signOut(this);
  }
  /** @internal */
  async _signOutCaptured(context, refreshing) {
    return signOutCaptured(this, context, refreshing);
  }
  /** @internal */
  async _revokeAccessSession(context, sessionId, preceding) {
    return revokeAccessSession(this, context, sessionId, preceding);
  }
  /** @internal */
  async getUser() {
    return getUser(this);
  }
  /** @internal */
  async updateUser(options) {
    return updateUser(this, options);
  }
  /** @internal */
  async refreshSession() {
    return refreshSession(this);
  }
  /** @internal */
  async _refreshSessionForContext(context) {
    return refreshSessionForContext(this, context);
  }
  /** @internal */
  async _fetchSessionRefresh(context) {
    return fetchSessionRefresh(this, context);
  }
  /** @internal */
  async _performSessionRefresh(context) {
    return performSessionRefresh(this, context);
  }
  /**
   * Register a callback for auth state changes.
   * @param {Function} callback - Called with user object (or null) on auth state change
   * @returns {Function} Unsubscribe function
   */
  /** @internal */
  onAuthStateChange(callback) {
    return onAuthStateChange(this, callback);
  }
  /** @internal */
  async signInAnonymously(metadata = {}) {
    return signInAnonymously(this, metadata);
  }
  /** @internal */
  async signUpAnonymous(metadata = {}) {
    return signUpAnonymous(this, metadata);
  }
  /** @internal */
  async convertAnonymous(options) {
    return convertAnonymous(this, options);
  }
  /** @internal */
  async confirmEmail(token) {
    return confirmEmail(this, token);
  }
  /** @internal */
  async resendConfirmation(email) {
    return resendConfirmation(this, email);
  }
  /** @internal */
  async forgotPassword(email) {
    return forgotPassword(this, email);
  }
  /** @internal */
  async resetPasswordForEmail(email) {
    return resetPasswordForEmail(this, email);
  }
  /** @internal */
  async resetPassword(options) {
    return resetPassword(this, options);
  }
  /** @internal */
  async requestEmailChange(newEmail) {
    return requestEmailChange(this, newEmail);
  }
  /** @internal */
  async confirmEmailChange(emailChangeToken) {
    return confirmEmailChange(this, emailChangeToken);
  }
  /** @internal */
  async cancelEmailChange() {
    return cancelEmailChange(this);
  }
  /** @internal */
  signInWithOAuth(provider, options = {}) {
    return signInWithOAuth(this, provider, options);
  }
  /** @internal */
  _resolveOAuthRedirectTarget(redirectTo) {
    return resolveOAuthRedirectTarget(redirectTo);
  }
  /** @internal */
  getHostedAuthUrl(options = {}) {
    return getHostedAuthUrl(this, options);
  }
  /** @internal */
  signInWithHostedAuth(options = {}) {
    return signInWithHostedAuth(this, options);
  }
  /** @internal */
  _resolveProjectIdForHostedAuth(explicitProjectId) {
    return resolveProjectIdForHostedAuth(this, explicitProjectId);
  }
  /** @internal */
  signInWithGoogle() {
    return signInWithProvider(this, "google");
  }
  /** @internal */
  signInWithGitHub() {
    return signInWithProvider(this, "github");
  }
  /** @internal */
  signInWithMicrosoft() {
    return signInWithProvider(this, "microsoft");
  }
  /** @internal */
  signInWithApple() {
    return signInWithProvider(this, "apple");
  }
  /** @internal */
  async linkOAuthProvider(provider) {
    return linkOAuthProvider(this, provider);
  }
  /** @internal */
  async unlinkOAuthProvider(provider) {
    return unlinkOAuthProvider(this, provider);
  }
  /** @internal */
  async getLinkedOAuthProviders() {
    return getLinkedOAuthProviders(this);
  }
  /** @internal */
  async refreshOAuthToken(provider) {
    return refreshOAuthToken(this, provider);
  }
  /** @internal */
  async getOAuthProviderToken(provider) {
    return getOAuthProviderToken(this, provider);
  }
  /** @internal */
  async callOAuthAPI(provider, params) {
    return callOAuthAPI(this, provider, params);
  }
  /** @internal */
  async getSessions(options = {}) {
    return getSessions(this, options);
  }
  /** @internal */
  async deleteSession(sessionId) {
    return deleteSession(this, sessionId);
  }
  /** @internal */
  async deleteAllOtherSessions() {
    return deleteAllOtherSessions(this);
  }
  /** @internal */
  async invokeFunction(functionName, payload = {}) {
    return invokeFunction(this, functionName, payload);
  }
  /** @internal */
  startDurableExecution(functionName, input = {}, options = {}) {
    return this._durableFacade.start(functionName, input, options);
  }
  /** @internal */
  getDurableExecution(projectId, functionName, executionId) {
    return this._durableFacade.get(projectId, functionName, executionId);
  }
  /** @internal */
  listDurableExecutions(projectId, functionName, options = {}) {
    return this._durableFacade.list(projectId, functionName, options);
  }
  /** @internal */
  stopDurableExecution(projectId, functionName, executionId) {
    return this._durableFacade.stop(projectId, functionName, executionId);
  }
  /** @internal */
  _captureAuthContext() {
    return captureAuthContext(this);
  }
  /** @internal */
  _adoptSessionInMemory(session) {
    adoptSessionInMemory(this, session);
  }
  /** @internal */
  _isAuthContextCurrent(context) {
    return isAuthContextCurrent(this, context);
  }
  /** @internal */
  _setSession(data, expectedGeneration = this._sessionGeneration) {
    return setSession(this, data, expectedGeneration);
  }
  /** @internal */
  _setRefreshedSession(data, context) {
    return setRefreshedSession(this, data, context);
  }
  /** @internal */
  _clearSession(context) {
    return clearSession(this, context);
  }
  /** @internal */
  _clearSessionAtGeneration(generation) {
    return clearSessionAtGeneration(this, generation);
  }
  /** @internal */
  _notifyAuthCallbacks(user) {
    notifyAuthCallbacks(this, user);
  }
  /** @internal */
  _hasOAuthCallbackInUrl() {
    return hasOAuthCallbackInUrl(this._peekAuthRedirectURL(), Boolean(this._peekAuthState()));
  }
  /** @internal */
  _consumeOAuthCodeFromUrl() {
    return consumeOAuthCodeFromUrl(this);
  }
  /** @internal */
  _completeOAuthExchange() {
    return completeOAuthExchange(this);
  }
  /** @internal */
  _stripOAuthQueryFromUrl(callbackURL) {
    stripOAuthQueryFromUrl(callbackURL);
  }
  /** @internal */
  _removeOAuthResponseParams(callbackURL, clearHash = true) {
    removeOAuthResponseParams(callbackURL, clearHash);
  }
  /**
   * Returns true when the current browser URL fragment carries a managed-auth
   * session hand-off (i.e. an access_token from a hosted login/signup redirect).
   * Cheap peek that does not mutate state.
   */
  /** @internal */
  _hasSessionInUrl() {
    return hasSessionInUrl();
  }
  /**
   * Adopt a session handed off by the managed hosted auth pages. After a
   * successful managed login/signup the user is redirected to the configured
   * URL with the tokens in the URL fragment:
   *   https://app/callback#access_token=...&refresh_token=...&token_type=bearer&expires_in=...
   * When present, the tokens are stored like any other session and removed from
   * the URL. Returns true if a session was adopted. Browser-only and idempotent.
   */
  /** @internal */
  _consumeSessionFromUrl() {
    return consumeSessionFromUrl(this);
  }
  /** @internal */
  _replaceSessionFromUrl(accessToken, refreshToken) {
    replaceSessionFromUrl(this, accessToken, refreshToken);
  }
  /**
   * Remove the managed-auth tokens from the URL fragment so they do not linger
   * in history, referrers, or bookmarks. Only strips when the fragment is
   * exclusively the hand-off params, to avoid clobbering app hash routing.
   */
  /** @internal */
  _stripAuthHashFromUrl(params) {
    stripAuthHashFromUrl(params);
  }
  // Generate a one-time, unguessable nonce for the managed/OAuth redirect flow.
  // This is a CSRF defense, so it must be cryptographically random — we require
  // Web Crypto (browsers and Node >= 20 provide it) rather than fall back to a
  // predictable PRNG.
  /** @internal */
  _generateAuthStateNonce() {
    return generateAuthStateNonce();
  }
  // Persist the nonce across the redirect. sessionStorage is per-tab+origin and
  // survives the navigation away to the hosted page and back to this origin.
  /** @internal */
  _storeAuthState(nonce, redirectURL = "") {
    storeAuthState(nonce, redirectURL);
  }
  // Read and clear the stored nonce (one-time use).
  /** @internal */
  _takeAuthState() {
    return takeAuthState();
  }
  /** @internal */
  _peekAuthState() {
    return peekAuthState();
  }
  /** @internal */
  _takeAuthRedirectURL() {
    return takeAuthRedirectUrl();
  }
  /** @internal */
  _peekAuthRedirectURL() {
    return peekAuthRedirectUrl();
  }
  /** @internal */
  _getStorageItem(key) {
    return getStorageItem(key);
  }
  /** @internal */
  _setStorageItem(key, value) {
    setStorageItem(key, value);
  }
  /** @internal */
  _removeStorageItem(key) {
    removeStorageItem(key);
  }
  /** @internal */
  _hasInitialSession() {
    return this._hasStoredSession() || this._hasSessionInUrl() || this._oauthExchangePromise !== null || this._oauthExchangeError !== null;
  }
  /** @internal */
  _hasStoredSession() {
    return this.accessToken !== null && this.accessToken !== "" || this.refreshToken !== null && this.refreshToken !== "";
  }
  async initialize() {
    if (!this._hasInitialSession()) {
      return { user: null, error: null };
    }
    await this._completeOAuthExchange();
    if (this._oauthExchangeError !== null) {
      const error = this._oauthExchangeError;
      this._oauthExchangeError = null;
      return { user: null, error };
    }
    return await this.getUser();
  }
  /**
   * @internal Test-only helper to ensure deterministic cache behavior in unit tests.
   */
  static __resetFunctionResolveCacheForTests() {
    clearSharedFunctionResolveStateForTests();
  }
  /**
   * @internal Test-only helper for asserting global resolver cache state.
   */
  static __getFunctionResolveCacheMetricsForTests() {
    const state = getSharedFunctionResolveState();
    return {
      cacheSize: state.cache.size,
      inFlightSize: state.inFlight.size,
      maxEntries: state.maxEntries
    };
  }
  /**
   * @internal Test-only helper for forcing resolver cache limits.
   */
  static __setFunctionResolveCacheMaxEntriesForTests(maxEntries) {
    const nextMax = Number(maxEntries);
    if (!Number.isInteger(nextMax) || nextMax < 1) {
      throw new Error("maxEntries must be a positive integer");
    }
    const state = getSharedFunctionResolveState();
    state.maxEntries = nextMax;
    pruneFunctionResolveCache(state, Date.now(), true);
  }
};

// src/server/volcano.ts
function env(...names) {
  for (const n of names) {
    const v = process.env[n];
    if (v) return v;
  }
  throw new Error(`Missing environment variable ${names[0]}`);
}
var apiUrl = () => env("VOLCANO_API_URL", "NEXT_PUBLIC_VOLCANO_API_URL");
var databaseName = () => process.env.VOLCANO_DATABASE || process.env.NEXT_PUBLIC_VOLCANO_DATABASE || "payroll";
function userClient(accessToken) {
  const v = new VolcanoAuth({ apiUrl: apiUrl(), anonKey: env("VOLCANO_ANON_KEY", "NEXT_PUBLIC_VOLCANO_ANON_KEY"), accessToken });
  v.database(databaseName());
  return v;
}
function serviceClient() {
  const key = env("VOLCANO_SERVICE_KEY");
  const v = new VolcanoAuth({ apiUrl: apiUrl(), anonKey: key, accessToken: key });
  v.database(databaseName());
  return v;
}

// src/lib/signing.ts
var import_node_crypto = require("node:crypto");
var hmacHex = (secret, msg) => (0, import_node_crypto.createHmac)("sha256", secret).update(msg, "utf8").digest("hex");
function signWebhook(secret, body, unixSeconds) {
  return `t=${unixSeconds},v1=${hmacHex(secret, `${unixSeconds}.${body}`)}`;
}
var WEBHOOK_BACKOFF_SECONDS = [60, 300, 1800, 7200, 43200];
var WEBHOOK_MAX_ATTEMPTS = WEBHOOK_BACKOFF_SECONDS.length + 1;
function nextAttemptAt(attemptsMade, now) {
  if (attemptsMade >= WEBHOOK_MAX_ATTEMPTS) return null;
  return new Date(now.getTime() + WEBHOOK_BACKOFF_SECONDS[attemptsMade - 1] * 1e3);
}

// src/server/webhooks.ts
async function deliverOnce(ep, d, now, fetchImpl, allowHttp) {
  if (!ep.active) return { ok: false, code: null, error: "Endpoint is inactive" };
  if (!allowHttp && !ep.url.startsWith("https://")) return { ok: false, code: null, error: "Webhook URLs must use https" };
  const body = JSON.stringify(d.payload);
  try {
    const res = await fetchImpl(ep.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "payroll-webhooks/1",
        "X-Payroll-Event": d.event,
        "X-Payroll-Delivery": d.id,
        "X-Payroll-Signature": signWebhook(ep.secret, body, Math.floor(now.getTime() / 1e3))
      },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(1e4)
    });
    return res.status >= 200 && res.status < 300 ? { ok: true, code: res.status, error: null } : { ok: false, code: res.status, error: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, code: null, error: String(e.message ?? e).slice(0, 500) };
  }
}
async function dispatchDue(db, opts = {}) {
  const now = opts.now ?? /* @__PURE__ */ new Date();
  const fetchImpl = opts.fetchImpl ?? fetch;
  const allowHttp = opts.allowHttp ?? process.env.PAYROLL_ALLOW_HTTP_WEBHOOKS === "true";
  const summary = { delivered: 0, retrying: 0, failed: 0 };
  const due = await rows(db.from("webhook_deliveries").select("id,endpoint_id,event,payload,attempts").eq("status", "pending").lte("next_attempt_at", now.toISOString()).order("next_attempt_at").limit(opts.limit ?? 50));
  if (due.length === 0) return summary;
  const endpoints = new Map((await rows(db.from("webhook_endpoints").select("id,url,secret,active").in("id", [...new Set(due.map((d) => d.endpoint_id))]))).map((e) => [e.id, e]));
  for (const d of due) {
    const ep = endpoints.get(d.endpoint_id);
    const r = ep ? await deliverOnce(ep, d, now, fetchImpl, allowHttp) : { ok: false, code: null, error: "Endpoint deleted" };
    const attempts = d.attempts + 1;
    if (r.ok) {
      summary.delivered++;
      await rows(db.update("webhook_deliveries", {
        status: "delivered",
        attempts,
        delivered_at: now.toISOString(),
        last_response_code: r.code,
        last_error: null
      }).eq("id", d.id));
      continue;
    }
    const next = nextAttemptAt(attempts, now);
    if (next) summary.retrying++;
    else summary.failed++;
    await rows(db.update("webhook_deliveries", {
      status: next ? "pending" : "failed",
      attempts,
      next_attempt_at: (next ?? now).toISOString(),
      last_response_code: r.code,
      last_error: r.error
    }).eq("id", d.id));
  }
  return summary;
}

// src/functions/payroll-run.ts
async function sendWebhooks() {
  try {
    return await dispatchDue(serviceClient());
  } catch (e) {
    console.error("webhook dispatch failed", e);
    return null;
  }
}
var handler = handle(async (event) => {
  const auth = authOf(event);
  const db = userClient(auth.access_token);
  await requireEmployee(db, auth, ["admin"]);
  const action = requireString(event.action, "action");
  if (action === "generate") {
    const period = await loadPeriod(db, requireString(event.period_id, "period_id"));
    if (period.status !== "locked") throw new HttpError(409, "PERIOD_NOT_LOCKED", "Lock the pay period before generating a run");
    const skipped = Array.isArray(event.skipped_employee_ids) ? event.skipped_employee_ids.map(String) : [];
    const { version } = await one(db.from("payroll_inputs").select("version"), "Payroll inputs version not found");
    const result = calculateRun(await loadCalcInput(db, period, skipped));
    await rows(db.delete("payroll_runs").eq("pay_period_id", period.id).eq("status", "draft"));
    const [run] = await rows(db.insert("payroll_runs", {
      pay_period_id: period.id,
      totals: asJson(result.totals),
      warnings: asJson(result.warnings),
      skipped_employee_ids: asJson(skipped),
      lines_input: asJson(result.lines),
      inputs_version: version
    }));
    return { run_id: run.id, totals: result.totals, warnings: result.warnings, line_count: result.lines.length };
  }
  const runId = requireString(event.run_id, "run_id");
  if (action === "finalize") {
    await mutated(db.update("payroll_runs", { status: "finalized" }).eq("id", runId).eq("status", "draft"), "this draft run");
    return { run_id: runId, status: "finalized", webhooks: await sendWebhooks() };
  }
  if (action === "void") {
    const reason = requireString(event.reason, "reason");
    await mutated(db.update("payroll_runs", { status: "voided", void_reason: reason }).eq("id", runId).eq("status", "finalized"), "this finalized run");
    return { run_id: runId, status: "voided", webhooks: await sendWebhooks() };
  }
  if (action === "discard") {
    await one(db.from("payroll_runs").select("id").eq("id", runId).eq("status", "draft"), "Draft run not found");
    await rows(db.delete("payroll_runs").eq("id", runId));
    return { run_id: runId, status: "deleted" };
  }
  throw new HttpError(400, "BAD_REQUEST", `Unknown action "${action}"`);
});
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  handler
});
