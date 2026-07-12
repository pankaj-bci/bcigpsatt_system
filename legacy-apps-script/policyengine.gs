// =============================================================================
// FILE: PolicyEngine.gs
// PURPOSE: Applies attendance policy rules for each day.
//          Takes raw punch data and outputs attendance status + flags.
//
// COMPLETE DAY EVALUATION ORDER:
//   1. Is it a public holiday?      → mark Holiday, stop
//   2. Is it Sunday with a punch?   → mark Working Sunday, stop
//   3. Is it Sunday with no punch?  → mark Weekly Off, stop
//   4. No punch on a working day    → mark Absent (deduct credit if available)
//   5. Probation rules              → zero tolerance policy
//   6. Fixed employee rules         → time buckets + monthly allowances
//
// KEY RULE — LEAVE FORM IS INFORMATION ONLY:
//   Leave requests do NOT change attendance calculation.
//   Salary is based purely on punch data + policy rules + allowances.
//   Leave form just tells admin in advance why someone is absent.
//
// ABSENT CREDIT LOGIC (Fixed employees):
//   Absent on working day + credit available → status = "Absent", deduct 1 credit
//   Absent on working day + no credit left   → status = "Unpaid Absent"
//
// All functions prefixed "Policy_"
// =============================================================================


/**
 * Policy_evaluateDay()
 *
 * PURPOSE: Master function. Evaluates one employee's attendance for one day.
 *          Returns a result object used by AttendanceEngine to write the summary.
 *
 * @param  {Object}        employee        - employee record from DB
 * @param  {string}        dateStr         - "yyyy-MM-dd"
 * @param  {Array<Object>} punchLogs       - punch logs for this employee on this date
 * @param  {Array<Object>} holidayList     - full holiday list from DB_getHolidayList()
 * @param  {Object}        monthlyCounters - running totals so far this month:
 *                                           { late_early_used, leave_credits_used }
 *
 * @return {Object} {
 *   status            : string   — final attendance status label
 *   in_time           : string   — "HH:MM:SS" or ''
 *   out_time          : string   — "HH:MM:SS" or ''
 *   late_flag         : boolean
 *   early_flag        : boolean
 *   half_day_flag     : boolean
 *   working_sunday    : boolean
 *   leave_credit_used : number   — 0, 0.5, or 1
 *   late_early_delta  : number   — 0 or 1 (add to monthly late_early_used)
 *   notes             : string
 * }
 */
function Policy_evaluateDay(employee, dateStr, punchLogs, holidayList, monthlyCounters) {

  // Guard: if employee object is missing/undefined, skip this day silently
  if (!employee || !employee.emp_id) {
    Logger.log('Policy_evaluateDay: Skipping — employee object is undefined for date ' + dateStr);
    return _build('', '', '', false, false, false, false, 0, 0, 'Skipped: no employee data');
  }

  var S    = CONFIG.STATUS;
  var date = new Date(dateStr + 'T00:00:00'); // force local midnight parse

  // ── STEP 1: Public holiday check ──────────────────────────────────────────
  var holiday = DB_isHoliday(dateStr, holidayList);
  if (holiday) {
    var hHasPunch = punchLogs && punchLogs.length > 0;
    if (hHasPunch) {
      // Employee worked on a public holiday — capture times + mark as Working Holiday
      var hIn  = _firstPunch(punchLogs, 'IN');
      var hOut = _lastPunch(punchLogs, 'OUT');
      return _build(
        S.WORKING_HOLIDAY,
        hIn  ? _extractTime(hIn.datetime)  : '',
        hOut ? _extractTime(hOut.datetime) : '',
        false, false, false, false, 0, 0,
        'Worked on Holiday: ' + holiday.holiday_name
      );
    }
    // No punch on holiday — normal holiday (notes contain the holiday name for UI display)
    return _build(S.HOLIDAY, '', '', false, false, false, false, 0, 0,
      'Public Holiday: ' + holiday.holiday_name);
  }

  // ── STEP 2 & 3: Sunday handling ───────────────────────────────────────────
  if (Config_isWeeklyOff(date)) {
    var hasPunch = punchLogs && punchLogs.length > 0;
    if (hasPunch) {
      // Employee came to work on Sunday — mark as Working Sunday
      var sIn  = _firstPunch(punchLogs, 'IN');
      var sOut = _lastPunch(punchLogs, 'OUT');
      return _build(
        S.WORKING_SUNDAY,
        sIn  ? _extractTime(sIn.datetime)  : '',
        sOut ? _extractTime(sOut.datetime) : '',
        false, false, false, true, 0, 0,
        'Working Sunday'
      );
    }
    // Normal Sunday off — no punch expected
    return _build(S.WEEKLY_OFF, '', '', false, false, false, false, 0, 0, 'Weekly Off');
  }

  // ── STEP 4: No punch on a working day ────────────────────────────────────
  if (!punchLogs || punchLogs.length === 0) {
    return Policy_evaluateAbsent(employee, monthlyCounters);
  }

  // ── STEP 4.5: Punch IN but NO Punch OUT on a working day ─────────────────
  //   The employee showed up (we have an IN) but never punched OUT. We cannot
  //   verify a full day, so this is NOT counted as a paid working day. It is
  //   flagged "Punch In Only" so the admin can review it in the report and
  //   decide case-by-case. Times are preserved for that review.
  var inCheck  = _firstPunch(punchLogs, 'IN');
  var outCheck = _lastPunch(punchLogs, 'OUT');
  if (inCheck && !outCheck) {
    return _build(
      S.PUNCH_IN_ONLY,
      _extractTime(inCheck.datetime),
      '',
      false, false, false, false, 0, 0,
      'Punch In Only — no Punch OUT recorded. Not counted as a working day.'
    );
  }

  // ── STEP 5 & 6: Has punches — apply type-specific policy ─────────────────
  if (employee.employee_type === 'Probation') {
    return Policy_evaluateProbation(employee, punchLogs);
  }
  return Policy_evaluateFixed(employee, punchLogs, monthlyCounters);
}


// =============================================================================
// ABSENT EVALUATION (working day, no punch)
// =============================================================================

/**
 * Policy_evaluateAbsent()
 *
 * PURPOSE: Handles the case where an employee has NO punch on a working day.
 *
 * LOGIC:
 *   Probation → always Unpaid Absent (zero allowance)
 *   Fixed     → if leave credit available: Absent + deduct 1 credit
 *               if no credit left:         Unpaid Absent
 *
 * NOTE: Leave request form does NOT change this outcome.
 *       The form is information only. Salary goes by credits only.
 *
 * @param  {Object} employee
 * @param  {Object} monthlyCounters - { late_early_used, leave_credits_used }
 * @return {Object} day result
 */
function Policy_evaluateAbsent(employee, monthlyCounters) {
  var S  = CONFIG.STATUS;
  var mc = monthlyCounters || { late_early_used: 0, leave_credits_used: 0 };

  // Guard: if employee is undefined, return unpaid absent safely
  if (!employee || !employee.employee_type) {
    Logger.log('Policy_evaluateAbsent: employee undefined — defaulting to Unpaid Absent');
    return _build(S.UNPAID_ABSENT, '', '', false, false, false, false, 0, 0, 'Error: employee data missing');
  }

  // Probation: zero tolerance, zero credits
  if (employee.employee_type === 'Probation') {
    return _build(S.UNPAID_ABSENT, '', '', false, false, false, false, 0, 0,
      'Probation: No punch — Unpaid Absent');
  }

  // Fixed: check remaining leave credits
  var creditsUsed = mc.leave_credits_used || 0;
  var creditLimit = CONFIG.FIXED.MONTHLY_LEAVE_CREDITS; // 1 credit per month

  if (creditsUsed < creditLimit) {
    // Still has credit — mark Absent and deduct 1 full credit
    return _build(S.ABSENT, '', '', false, false, false, false, 1, 0,
      'Absent — 1 leave credit used (' + (creditsUsed + 1) + '/' + creditLimit + ' this month)');
  }

  // No credits left — Unpaid Absent
  return _build(S.UNPAID_ABSENT, '', '', false, false, false, false, 0, 0,
    'Absent — No leave credits remaining. Unpaid.');
}


// =============================================================================
// PROBATION EVALUATION
// =============================================================================

/**
 * Policy_evaluateProbation()
 *
 * PURPOSE: Zero-tolerance rules for probation employees.
 *
 * RULES:
 *   Punch IN  after 9:36 AM  → violation
 *   Punch OUT before 6:30 PM → violation
 *   Either violation alone   → Half Day (penalty, no credits)
 *   Both correct             → Present
 *
 * @param  {Object}        employee
 * @param  {Array<Object>} punchLogs
 * @return {Object} day result
 */
function Policy_evaluateProbation(employee, punchLogs) {
  var S          = CONFIG.STATUS;
  var shiftStart = Config_shiftStartMinutes();                              // 570 (9:30)
  var shiftEnd   = Config_shiftEndMinutes();                                // 1110 (18:30)
  var lateLimit  = shiftStart + CONFIG.PROBATION.LATE_THRESHOLD_MINUTES;   // 576 (9:36)

  var inLog  = _firstPunch(punchLogs, 'IN');
  var outLog = _lastPunch(punchLogs, 'OUT');

  var inTime  = inLog  ? _timeToMinutes(_extractTime(inLog.datetime))  : null;
  var outTime = outLog ? _timeToMinutes(_extractTime(outLog.datetime)) : null;

  var lateViolation  = (inTime  === null || inTime  > lateLimit);
  var earlyViolation = (outTime === null || outTime < shiftEnd);

  if (lateViolation || earlyViolation) {
    var msgs = [];
    if (lateViolation)  msgs.push('Late IN: '   + (inLog  ? _extractTime(inLog.datetime)  : 'No punch'));
    if (earlyViolation) msgs.push('Early OUT: ' + (outLog ? _extractTime(outLog.datetime) : 'No punch'));
    return _build(
      S.HALF_DAY,
      inLog  ? _extractTime(inLog.datetime)  : '',
      outLog ? _extractTime(outLog.datetime) : '',
      lateViolation, earlyViolation, true, false, 0, 0,
      'Probation violation — ' + msgs.join('; ')
    );
  }

  return _build(
    S.PRESENT,
    _extractTime(inLog.datetime),
    _extractTime(outLog.datetime),
    false, false, false, false, 0, 0, ''
  );
}


// =============================================================================
// FIXED EMPLOYEE EVALUATION
// =============================================================================

/**
 * Policy_evaluateFixed()
 *
 * PURPOSE: Applies the time-bucket rules and monthly allowance logic
 *          for Fixed employees.
 *
 * PUNCH IN BUCKETS (minutes after 9:30 AM):
 *   ≤ 6 min     → On Time   (≤ 9:36 AM)
 *   6–90 min    → Late      (9:36–11:00 AM)
 *   90min–14:00 → Half Day  (11:00 AM–2:00 PM)
 *   ≥ 14:00     → Absent    (handled in evaluateAbsent before reaching here)
 *
 * PUNCH OUT BUCKETS:
 *   ≥ 18:30     → On Time
 *   17:00–18:30 → Early Going
 *   14:00–17:00 → Half Day
 *   < 14:00     → Absent    (handled before reaching here)
 *
 * MONTHLY PENALTY LOGIC:
 *   Late/Early #1–3   → free (just flagged)
 *   Late/Early #4+    → each costs 0.5 leave credit (half day penalty)
 *   Half Day          → costs 0.5 leave credit (if available)
 *   Both IN late AND OUT early on same day → counted as 2 violations
 *
 * @param  {Object}        employee
 * @param  {Array<Object>} punchLogs
 * @param  {Object}        monthlyCounters
 * @return {Object} day result
 */
function Policy_evaluateFixed(employee, punchLogs, monthlyCounters) {
  var S  = CONFIG.STATUS;
  var FX = CONFIG.FIXED;
  var mc = monthlyCounters || { late_early_used: 0, leave_credits_used: 0 };

  var shiftStart    = Config_shiftStartMinutes();   // 570  (9:30 AM)
  var shiftEnd      = Config_shiftEndMinutes();     // 1110 (6:30 PM)
  var earlyMin      = FX.EARLY_MIN_HOUR * 60 + FX.EARLY_MIN_MINUTE;      // 1020 (5:00 PM)
  var halfDayOutMin = FX.HALF_DAY_OUT_MIN_HOUR * 60 + FX.HALF_DAY_OUT_MIN_MINUTE; // 840 (2:00 PM)

  var inLog  = _firstPunch(punchLogs, 'IN');
  var outLog = _lastPunch(punchLogs, 'OUT');

  var inTime  = inLog  ? _timeToMinutes(_extractTime(inLog.datetime))  : null;
  var outTime = outLog ? _timeToMinutes(_extractTime(outLog.datetime)) : null;

  // ── Classify Punch IN ─────────────────────────────────────────────────────
  var inStatus = 'absent';
  if (inTime !== null) {
    var minsLate = inTime - shiftStart;
    if      (minsLate <= FX.ON_TIME_MAX_MINUTES)              inStatus = 'ontime';
    else if (minsLate <= FX.LATE_MAX_MINUTES)                 inStatus = 'late';
    else if (inTime   <  FX.HALF_DAY_IN_MAX_HOUR * 60)       inStatus = 'halfday';
    else                                                       inStatus = 'absent';
  }

  // ── Classify Punch OUT ────────────────────────────────────────────────────
  // IMPORTANT: If IN is already 'halfday' (punched in between 11AM–2PM),
  // the OUT time only needs to exist — the day is already a half day.
  // We do NOT apply the OUT absent bucket when IN is already halfday.
  var outStatus = 'absent';
  if (outTime !== null) {
    if      (outTime >= shiftEnd)      outStatus = 'ontime';
    else if (outTime >= earlyMin)      outStatus = 'early';
    else if (outTime >= halfDayOutMin) outStatus = 'halfday';
    else if (inStatus === 'halfday')   outStatus = 'halfday'; // IN already halfday — OUT just confirms presence
    else                               outStatus = 'absent';
  }

  // ── Handle absent IN or OUT ───────────────────────────────────────────────
  // If IN falls in the absent bucket (≥ 2PM) → full absent
  // If OUT falls in absent bucket BUT IN was halfday → still halfday (not absent)
  //
  // CRITICAL: Even when we redirect to Absent, we PRESERVE any partial punch
  // times so the daily log shows what the employee actually did. The Absent
  // status is correct; the IN time is just visible context.
  if (inStatus === 'absent') {
    var ra = Policy_evaluateAbsent(employee, mc);
    ra.in_time  = inLog  ? _extractTime(inLog.datetime)  : '';
    ra.out_time = outLog ? _extractTime(outLog.datetime) : '';
    return ra;
  }
  if (outStatus === 'absent') {
    // OUT is absent only if IN was NOT already a half day situation
    if (inStatus !== 'halfday') {
      var rb = Policy_evaluateAbsent(employee, mc);
      rb.in_time  = inLog  ? _extractTime(inLog.datetime)  : '';
      rb.out_time = outLog ? _extractTime(outLog.datetime) : '';
      return rb;
    }
    // IN was halfday and OUT is any time before 2PM — still counts as half day
    outStatus = 'halfday';
  }

  // ── Both punches exist and are not absent — compute flags ─────────────────
  var lateFlag    = (inStatus  === 'late');
  var earlyFlag   = (outStatus === 'early');
  var halfDayFlag = (inStatus  === 'halfday' || outStatus === 'halfday');

  // Running counters (will be updated as we apply penalties)
  var newLateEarlyUsed   = mc.late_early_used    || 0;
  var newCreditsUsed     = mc.leave_credits_used || 0;
  var creditDelta        = 0;  // credits to deduct THIS day
  var lateEarlyDelta     = 0;  // late/early incidents to add THIS day
  var notes              = [];
  var status             = S.PRESENT;

  // ── Case 1: Half Day (IN or OUT in half-day bucket) ───────────────────────
  if (halfDayFlag) {
    status = S.HALF_DAY;
    if (inStatus  === 'halfday') notes.push('Late IN ('  + _minutesToStr(inTime)  + ')');
    if (outStatus === 'halfday') notes.push('Early OUT (' + _minutesToStr(outTime) + ')');

    // Deduct 0.5 leave credit if available
    if (newCreditsUsed < CONFIG.FIXED.MONTHLY_LEAVE_CREDITS) {
      creditDelta = 0.5;
      notes.push('0.5 leave credit used');
    } else {
      notes.push('No leave credits — penalty half day');
    }
  }

  // ── Case 2: Late IN (not half day) ────────────────────────────────────────
  else if (lateFlag && !halfDayFlag) {
    lateEarlyDelta = 1;
    newLateEarlyUsed += 1;
    notes.push('Late IN (' + _minutesToStr(inTime) + ')');

    if (newLateEarlyUsed > CONFIG.FIXED.MONTHLY_LATE_EARLY_FREE) {
      // Exceeded free allowance — becomes half day penalty
      halfDayFlag = true;
      status      = S.HALF_DAY;
      creditDelta = 0.5;
      notes.push('Penalty: ' + newLateEarlyUsed + 'th late/early this month → half day');
    } else {
      notes.push('Late/early ' + newLateEarlyUsed + '/' + CONFIG.FIXED.MONTHLY_LATE_EARLY_FREE + ' free used');
    }
  }

  // ── Case 3: Early OUT (not half day) ─────────────────────────────────────
  else if (earlyFlag && !halfDayFlag) {
    lateEarlyDelta = 1;
    newLateEarlyUsed += 1;
    notes.push('Early OUT (' + _minutesToStr(outTime) + ')');

    if (newLateEarlyUsed > CONFIG.FIXED.MONTHLY_LATE_EARLY_FREE) {
      halfDayFlag = true;
      status      = S.HALF_DAY;
      creditDelta = 0.5;
      notes.push('Penalty: ' + newLateEarlyUsed + 'th late/early this month → half day');
    } else {
      notes.push('Late/early ' + newLateEarlyUsed + '/' + CONFIG.FIXED.MONTHLY_LATE_EARLY_FREE + ' free used');
    }
  }

  // ── Case 4: Both late IN and early OUT on same day ─────────────────────
  // (each is counted as a separate late/early incident)
  if (lateFlag && earlyFlag && !halfDayFlag) {
    // Already handled above individually, but flag both
    lateEarlyDelta = 2; // two incidents in one day
  }

  return _build(
    status,
    inLog  ? _extractTime(inLog.datetime)  : '',
    outLog ? _extractTime(outLog.datetime) : '',
    lateFlag, earlyFlag, halfDayFlag, false,
    creditDelta, lateEarlyDelta,
    notes.join('; ')
  );
}


// =============================================================================
// PRIVATE HELPER FUNCTIONS
// =============================================================================

/**
 * _build()
 * PURPOSE: Creates a standardised day-result object.
 *          All evaluation functions return via this helper for consistency.
 */
function _build(status, inTime, outTime, late, early, halfDay, workSun, creditDelta, leDelta, notes) {
  return {
    status            : status,
    in_time           : inTime,
    out_time          : outTime,
    late_flag         : late,
    early_flag        : early,
    half_day_flag     : halfDay,
    working_sunday    : workSun,
    leave_credit_used : creditDelta,  // amount to deduct from monthly credits today
    late_early_delta  : leDelta,      // number of late/early incidents today
    notes             : notes
  };
}

/**
 * _firstPunch()
 * PURPOSE: Returns the first punch of a given action type from a log array.
 * @param  {Array}  logs
 * @param  {string} action - "IN" or "OUT"
 * @return {Object|null}
 */
function _firstPunch(logs, action) {
  for (var i = 0; i < logs.length; i++) {
    if (logs[i].action === action) return logs[i];
  }
  return null;
}

/**
 * _lastPunch()
 * PURPOSE: Returns the last punch of a given action type from a log array.
 *          We use the LAST punch OUT so that if someone punches out twice,
 *          we take the later one.
 * @param  {Array}  logs
 * @param  {string} action
 * @return {Object|null}
 */
function _lastPunch(logs, action) {
  var last = null;
  for (var i = 0; i < logs.length; i++) {
    if (logs[i].action === action) last = logs[i];
  }
  return last;
}

/**
 * _extractTime()
 * PURPOSE: Extracts the "HH:MM:SS" time portion from a "yyyy-MM-dd HH:MM:SS" datetime string.
 * @param  {string} datetime
 * @return {string}
 */
function _extractTime(datetime) {
  if (!datetime) return '';
  var parts = datetime.toString().split(' ');
  return parts.length > 1 ? parts[1] : '';
}

/**
 * _timeToMinutes()
 * PURPOSE: Converts "HH:MM:SS" or "HH:MM" string to total minutes from midnight.
 *          e.g. "09:36:00" → 576
 * @param  {string} timeStr
 * @return {number|null}
 */
function _timeToMinutes(timeStr) {
  if (!timeStr) return null;
  var parts = timeStr.split(':');
  return parseInt(parts[0]) * 60 + parseInt(parts[1]);
}

/**
 * _minutesToStr()
 * PURPOSE: Converts total minutes from midnight to "HH:MM" display string.
 *          e.g. 576 → "09:36"
 * @param  {number} mins
 * @return {string}
 */
function _minutesToStr(mins) {
  if (mins === null || mins === undefined) return '--:--';
  var h = Math.floor(mins / 60);
  var m = mins % 60;
  return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
}