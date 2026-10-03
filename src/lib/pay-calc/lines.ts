import { divRoundHalfUp } from '../money';
import type { CalcEmployee, EarningCode, PayType, RunLine } from '../types';

interface Bucket {
  code: EarningCode;
  payType: PayType;
  /** base rate in cents; 0 for informational buckets */
  rate: number;
  /** multiplier × 1000; 0 for informational buckets */
  m1000: number;
  h100: number | null;
  d10: number | null;
}

interface Fixed {
  code: EarningCode;
  payType: PayType;
  rate: number;
  amount: number;
  h100: number | null;
  d10: number | null;
}

const add = (a: number | null, b: number): number => (a ?? 0) + b;

/**
 * Collects quantities per (code, pay type, base rate, multiplier) and turns them
 * into run lines, rounding once per line.
 */
export class LineAccumulator {
  private buckets = new Map<string, Bucket>();
  private fixed: Fixed[] = [];

  constructor(private readonly emp: CalcEmployee) {}

  private bucket(code: EarningCode, payType: PayType, rate: number, m1000: number): Bucket {
    const key = `${code}|${payType}|${rate}|${m1000}`;
    let b = this.buckets.get(key);
    if (!b) {
      b = { code, payType, rate, m1000, h100: null, d10: null };
      this.buckets.set(key, b);
    }
    return b;
  }

  /** Paid hours: amount = hours × rate × multiplier. */
  addHours(code: EarningCode, payType: PayType, rate: number, m1000: number, h100: number): void {
    if (h100 <= 0) return;
    const b = this.bucket(code, payType, rate, m1000);
    b.h100 = add(b.h100, h100);
  }

  /** Paid days: amount = days × rate. Hours, if entered, are reported but not paid. */
  addDays(code: EarningCode, payType: PayType, rate: number, d10: number, h100 = 0): void {
    if (d10 <= 0) return;
    const b = this.bucket(code, payType, rate, 1000);
    b.d10 = add(b.d10, d10);
    if (h100 > 0) b.h100 = add(b.h100, h100);
  }

  /** Quantity reported with no pay (e.g. PTO hours for a salaried employee). */
  addInfo(code: EarningCode, payType: PayType, h100: number, d10: number): void {
    if (h100 <= 0 && d10 <= 0) return;
    const b = this.bucket(code, payType, 0, 0);
    if (h100 > 0) b.h100 = add(b.h100, h100);
    if (d10 > 0) b.d10 = add(b.d10, d10);
  }

  /** A line whose amount the caller computed (salary segment, day-rate OT premium). */
  addFixed(line: Fixed): void {
    this.fixed.push(line);
  }

  lines(): RunLine[] {
    const base = {
      employee_id: this.emp.id,
      external_id: this.emp.external_id,
      first_name: this.emp.first_name,
      last_name: this.emp.last_name,
      email: this.emp.email,
      work_state: this.emp.work_state,
    };
    const out: RunLine[] = [];
    for (const f of this.fixed) {
      out.push({
        ...base,
        pay_type: f.payType,
        earning_code: f.code,
        hours: f.h100 == null ? null : f.h100 / 100,
        days: f.d10 == null ? null : f.d10 / 10,
        rate_cents: f.rate,
        amount_cents: f.amount,
      });
    }
    for (const b of this.buckets.values()) {
      let amount = 0;
      let rate = 0;
      if (b.m1000 > 0 && b.d10 != null) {
        amount = divRoundHalfUp(b.d10 * b.rate, 10);
        rate = b.rate;
      } else if (b.m1000 > 0 && b.h100 != null) {
        amount = divRoundHalfUp(b.h100 * b.rate * b.m1000, 100_000);
        rate = divRoundHalfUp(b.rate * b.m1000, 1000);
      }
      out.push({
        ...base,
        pay_type: b.payType,
        earning_code: b.code,
        hours: b.h100 == null ? null : b.h100 / 100,
        days: b.d10 == null ? null : b.d10 / 10,
        rate_cents: rate,
        amount_cents: amount,
      });
    }
    return out;
  }
}
