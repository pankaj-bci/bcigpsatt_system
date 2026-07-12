// =============================================================================
// FILE: AttendanceEngine.gs
// PURPOSE: Coordinates punch processing and daily attendance computation.
//          Loads holiday list once per batch and passes it to PolicyEngine.
//          All functions prefixed "Attendance_"
// =============================================================================

/**
 * Attendance_processPunch()
 * PURPOSE: Full punch validation pipeline called on every Punch IN/OUT.
 *          Steps: find employee → check active → GPS accuracy → location →
 *                 anti-fraud → save punch → re-evaluate today's summary.
 *
 * @param  {string} email
 * @param  {string} action   - "IN" or "OUT"
 * @param  {number} lat
 * @param  {number} lon
 * @param  {number} accuracy - GPS accuracy in metres
 * @return {Object} { success, message }
 */
function Attendance_processPunch(email, action, lat, lon, accuracy, locationId) {

  // 1. Find and validate employee
  var emp = DB_getEmployeeByEmail(email);
  if (!emp) {
    return { success: false, message: 'Your email is not registered in this system. Contact admin.' };
  }
  if (emp.status !== 'Active') {
    return { success: false, message: 'Your account is currently Inactive. Contact admin.' };
  }

  // 2. GPS accuracy check
  var accCheck = Loc_validateAccuracy(accuracy);
  if (!accCheck.valid) return { success: false, message: accCheck.message };

  // 3. Location validation
  //    WFH and OTHER use an inverted distance check (must be FAR from head office).
  //    All other location IDs use the standard geofence check.
  var locResult;
  var locType = '';
  var locName = '';

  if (locationId === 'WFH' || locationId === 'OTHER') {
    var office     = DB_getOfficeLocation();
    var distToOff  = Loc_haversineDistance(lat, lon, office.latitude, office.longitude);
    var isWfh      = (locationId === 'WFH');
    var minDist    = isWfh ? CONFIG.WFH_MIN_DISTANCE_METERS : CONFIG.OTHER_MIN_DISTANCE_METERS;

    if (distToOff <= minDist) {
      return {
        success: false,
        message: isWfh
          ? '❌ You appear to be near the office (' + Math.round(distToOff) + 'm away). Please use the Head Office tile.'
          : '❌ You\'re near the office (' + Math.round(distToOff) + 'm away). Please use the Head Office tile.'
      };
    }

    locType   = isWfh ? 'WFH' : 'OTHER';
    locName   = isWfh ? 'Work From Home' : 'Other';
    locResult = {
      valid   : true,
      message : '✅ ' + locName + ' verified (' + Math.round(distToOff) + 'm from office).'
    };

  } else {
    // Standard fixed-location flow.
    // Employee selects location from the frontend → use that.
    // Falls back to assigned_location_id only for legacy compatibility.
    var assigned;
    if (locationId) {
      assigned = DB_getLocationById(locationId);
      if (!assigned) {
        return { success: false, message: 'Selected location not found. Please refresh and try again.' };
      }
    } else {
      assigned = DB_getLocationById(emp.assigned_location_id);
      if (!assigned) {
        return { success: false, message: 'No location found. Please select your location on the punch screen.' };
      }
    }

    if (action === 'IN') {
      locResult = Loc_validatePunchIn(lat, lon, assigned);
    } else {
      locResult = Loc_validatePunchOut(lat, lon, assigned, DB_getOfficeLocation());
    }
    if (!locResult.valid) return { success: false, message: locResult.message };

    locType = (assigned.location_id === CONFIG.OFFICE_LOCATION.location_id)
              ? 'HEAD_OFFICE' : 'WORKSHOP';
    locName = assigned.location_name;
  }

  // 4. Anti-fraud check (DAY-SCOPED — see function below)
  var fraud = Attendance_validateAntiFraud(emp.emp_id, action);
  if (!fraud.valid) return { success: false, message: fraud.message };

  // 5. Save punch — locked (protects PUNCH_LOGS append from race conditions).
  //    Lock is held ONLY for the append (~0.5s), then released immediately.
  //    Day re-evaluation runs OUTSIDE the lock — each employee writes their
  //    own ATTENDANCE_SUMMARY row so concurrent evaluation is safe.
  //    waitLock(20000): handles 20s ÷ 0.5s = 40 simultaneous peak-hour punches.
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000);
  } catch (lockErr) {
    return { success: false, message: 'System busy, please try again in a moment.' };
  }

  var tz    = Session.getScriptTimeZone();
  var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');

  try {
    // Re-check anti-fraud INSIDE the lock — guards the race window between
    // the first check above and acquiring the lock.
    var fraud2 = Attendance_validateAntiFraud(emp.emp_id, action);
    if (!fraud2.valid) {
      return { success: false, message: fraud2.message };
    }
    DB_savePunchLog(emp.emp_id, action, lat, lon, locType, locName);
  } catch (saveErr) {
    Logger.log('Attendance_processPunch save error for ' + emp.emp_id + ': ' + saveErr.message);
    return { success: false, message: 'Could not record punch. Please try again.' };
  } finally {
    lock.releaseLock(); // release BEFORE day re-evaluation — punch is safely saved
  }

  // 6. Re-evaluate today OUTSIDE the lock — safe because each employee's
  //    ATTENDANCE_SUMMARY row is independent (no cross-employee conflicts).
  try {
    Attendance_processDayForEmployee(emp, today);
  } catch (evalErr) {
    Logger.log('Attendance_processPunch eval warning ' + emp.emp_id + ': ' + evalErr.message);
    // Punch IS saved — nightly trigger will recompute the summary tonight.
  }

  return {
    success : true,
    message : locResult.message + '\nPunch ' + action + ' recorded at ' +
              Utilities.formatDate(new Date(), tz, 'HH:mm:ss') + '.'
  };
}


/**
 * Attendance_validateAntiFraud()
 * PURPOSE: Prevents duplicate punches, cooldown violations, sequence errors.
 *
 * DAY-SCOPED LOGIC (the fix for the "forgot to punch out yesterday" problem):
 *   • Every calendar day starts fresh. Yesterday's state NEVER affects today.
 *   • PUNCH IN  → allowed unless you already have an open IN today
 *                 (i.e. today's last punch was IN with no OUT after it).
 *   • PUNCH OUT → allowed ONLY if you have an IN today that isn't already
 *                 closed by an OUT. No same-day IN → friendly error.
 *   • Cooldown  → still applies to the most recent punch (prevents double-tap).
 *
 *   Because we only look at TODAY's punches, a forgotten OUT from yesterday is
 *   simply left dangling (the nightly trigger flags it "Punch In Only") and
 *   the employee can punch IN normally the next morning.
 *
 * @param  {string} empId
 * @param  {string} action - "IN" or "OUT"
 * @return {Object} { valid, message }
 */
function Attendance_validateAntiFraud(empId, action) {
  var tz    = Session.getScriptTimeZone();
  var today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');

  // Today's punches, in chronological order
  var todayLogs = DB_getPunchLogsForDate(empId, today);
  todayLogs.sort(function(a, b) {
    return a.datetime < b.datetime ? -1 : (a.datetime > b.datetime ? 1 : 0);
  });

  var lastToday = todayLogs.length ? todayLogs[todayLogs.length - 1] : null;

  // Cooldown — based on the most recent punch overall (prevents accidental
  // double-tap). Across days the gap is huge so this only ever bites same-day.
  var lastEver = DB_getLastPunchLog(empId);
  if (lastEver) {
    var cooldown = CONFIG.PUNCH_COOLDOWN_MINUTES;
    var diffMins = (new Date() - new Date(lastEver.datetime)) / 1000 / 60;
    if (diffMins < cooldown) {
      var secsLeft = Math.ceil((cooldown - diffMins) * 60);
      return { valid: false, message: 'Please wait ' + secsLeft + ' more second(s) before punching again.' };
    }
  }

  if (action === 'IN') {
    // Block only if there's an OPEN in today (last today action is IN)
    if (lastToday && lastToday.action === 'IN') {
      return {
        valid   : false,
        message : 'You already punched IN today at ' + _timeOnly(lastToday.datetime) +
                  '. Please punch OUT first.'
      };
    }
    return { valid: true, message: 'OK' };
  }

  // action === 'OUT'
  if (!lastToday) {
    return { valid: false, message: 'Cannot Punch OUT — no Punch IN found for today.' };
  }
  if (lastToday.action === 'OUT') {
    return {
      valid   : false,
      message : 'You already punched OUT today at ' + _timeOnly(lastToday.datetime) +
                '. Please punch IN first.'
    };
  }
  // lastToday.action === 'IN' → valid OUT
  return { valid: true, message: 'OK' };
}

/** Internal: extract "HH:mm:ss" from "yyyy-MM-dd HH:mm:ss" (or return as-is). */
function _timeOnly(dtStr) {
  if (!dtStr) return '';
  var parts = dtStr.toString().split(' ');
  return parts.length > 1 ? parts[1] : dtStr;
}


/**
 * Attendance_processDayForEmployee()
 * PURPOSE: Computes and saves the attendance summary for one employee on one date.
 *          Loads holiday list, fetches punches, gets running monthly counters,
 *          runs PolicyEngine, and saves the result.
 *
 *          Called at punch time AND by the nightly trigger.
 *
 * @param {Object} employee
 * @param {string} dateStr  - "yyyy-MM-dd"
 */
function Attendance_processDayForEmployee(employee, dateStr) {
  // Guard: skip if employee object is invalid
  if (!employee || !employee.emp_id) {
    Logger.log('Attendance_processDayForEmployee: Skipping — invalid employee object');
    return;
  }

  var tz       = Session.getScriptTimeZone();
  var monthStr = dateStr.substring(0, 7); // "yyyy-MM"

  // Load data needed for evaluation
  var punchLogs    = DB_getPunchLogsForDate(employee.emp_id, dateStr);
  var holidayList  = DB_getHolidayList();

  // CRITICAL FIX: Compute running monthly counters from the DAILY records before
  // this date — NOT from the MONTHLY_SUMMARY sheet, because that sheet is only
  // refreshed at month-end by the monthly trigger. Reading it mid-month gives
  // zero counters for every day, which makes every absent get a credit deduction
  // (the bug behind "1/2 used" repeating on every absent record).
  var counters = _computeCountersFromDailies(employee.emp_id, monthStr, dateStr);

  // Run the policy engine for this day
  var result = Policy_evaluateDay(employee, dateStr, punchLogs, holidayList, counters);

  // Save daily summary
  DB_saveAttendanceSummary({
    emp_id           : employee.emp_id,
    date             : dateStr,
    in_time          : result.in_time,
    out_time         : result.out_time,
    status           : result.status,
    late_flag        : result.late_flag,
    early_flag       : result.early_flag,
    half_day_flag    : result.half_day_flag,
    working_sunday   : result.working_sunday,
    leave_credit_used: result.leave_credit_used,
    notes            : result.notes
  });

  Logger.log('Attendance_processDayForEmployee: ' + employee.emp_id +
             ' | ' + dateStr + ' | ' + result.status);
}


/**
 * _computeCountersFromDailies()
 *
 * PURPOSE: Sums up running monthly counters by walking the actual daily
 *          attendance records BEFORE the given date. Replaces the broken
 *          dependency on MONTHLY_SUMMARY which is only updated at month-end.
 *
 * @param  {string} empId
 * @param  {string} monthStr   - "yyyy-MM"
 * @param  {string} beforeDate - "yyyy-MM-dd" — exclude this date and later
 * @return {{late_early_used:number, leave_credits_used:number}}
 */
function _computeCountersFromDailies(empId, monthStr, beforeDate) {
  var dailies = DB_getAttendanceSummaryForEmployee(empId, monthStr);
  var le = 0, cr = 0;
  for (var i = 0; i < dailies.length; i++) {
    var d = dailies[i];
    if (beforeDate && d.date >= beforeDate) continue; // strictly before
    if (d.late_flag)  le += 1;
    if (d.early_flag) le += 1;
    cr += parseFloat(d.leave_credit_used) || 0;
  }
  return { late_early_used: le, leave_credits_used: cr };
}


/**
 * Attendance_runDailyTrigger()
 * PURPOSE: Processes ALL active employees for yesterday.
 *          Attached to a daily time-driven trigger (runs at 11 PM).
 *          Loads holiday list ONCE and reuses it for all employees.
 */
function Attendance_runDailyTrigger() {
  var tz        = Session.getScriptTimeZone();
  var yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  var dateStr   = Utilities.formatDate(yesterday, tz, 'yyyy-MM-dd');
  var monthStr  = dateStr.substring(0, 7);

  var employees   = DB_getAllEmployees();
  var holidayList = DB_getHolidayList(); // load once, reuse for all employees

  employees.forEach(function(emp) {
    if (!emp || !emp.emp_id) {
      Logger.log('Attendance_runDailyTrigger: Skipping invalid employee row');
      return;
    }
    if (emp.status !== 'Active') return;

    try {
      var punchLogs = DB_getPunchLogsForDate(emp.emp_id, dateStr);

      // IMPORTANT: read counters from actual daily records, NOT from
      // MONTHLY_SUMMARY — that sheet is only updated on dashboard/report
      // loads, so it can be stale and cause wrong credit deductions.
      var counters = _computeCountersFromDailies(emp.emp_id, monthStr, dateStr);

      var result = Policy_evaluateDay(emp, dateStr, punchLogs, holidayList, counters);

      if (!result.status) {
        Logger.log('Attendance_runDailyTrigger: Skipping save for ' + emp.emp_id + ' — empty result');
        return;
      }

      DB_saveAttendanceSummary({
        emp_id           : emp.emp_id,
        date             : dateStr,
        in_time          : result.in_time,
        out_time         : result.out_time,
        status           : result.status,
        late_flag        : result.late_flag,
        early_flag       : result.early_flag,
        half_day_flag    : result.half_day_flag,
        working_sunday   : result.working_sunday,
        leave_credit_used: result.leave_credit_used,
        notes            : result.notes
      });
    } catch(e) {
      Logger.log('Attendance_runDailyTrigger: Error for ' + emp.emp_id + ' — ' + e.message);
    }
  });

  // Refresh MONTHLY_SUMMARY for all employees so dashboard/report totals
  // are always current — this runs at 11 PM when no one is using the system.
  try {
    Report_generateMonthlySummary(monthStr);
  } catch(e) {
    Logger.log('Attendance_runDailyTrigger: Monthly summary error — ' + e.message);
  }

  Logger.log('Attendance_runDailyTrigger: Completed for ' + dateStr +
             ' (' + employees.length + ' employees)');
}


/**
 * Attendance_backfillMissingDays()
 *
 * PURPOSE: Fills in attendance records for any past working days in a given
 *          month that have NO record yet for this employee.
 *
 *          Handles the common case where an employee is added mid-month
 *          or the nightly trigger hasn't run for them. Called from
 *          Server_getMyDashboard and Server_getAdminReport so the very first
 *          time a dashboard loads, all past days are caught up.
 *
 * COUNTER LOGIC (the previous bug fix):
 *          We maintain in-memory running counters for the loop instead of
 *          re-reading the monthly summary on every iteration. This ensures
 *          credit deductions stop correctly once the monthly limit is hit,
 *          and the "1/1" → "Unpaid Absent" sequence is respected.
 *
 * @param {Object} employee  - employee record
 * @param {string} monthStr  - "yyyy-MM"
 */
function Attendance_backfillMissingDays(employee, monthStr) {
  if (!employee || !employee.emp_id) return 0;

  var tz          = Session.getScriptTimeZone();
  var today       = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  var holidayList = DB_getHolidayList();

  // Existing records for this month — keep a set of dates already present,
  // and use them to seed the running counters.
  var existing      = DB_getAttendanceSummaryForEmployee(employee.emp_id, monthStr);
  var existingDates = {};
  var counters      = { late_early_used: 0, leave_credits_used: 0 };
  existing.forEach(function(r) {
    existingDates[r.date] = true;
    if (r.late_flag)  counters.late_early_used += 1;
    if (r.early_flag) counters.late_early_used += 1;
    counters.leave_credits_used += parseFloat(r.leave_credit_used) || 0;
  });

  // Walk every day of the month up to (but not including) today
  var parts     = monthStr.split('-');
  var year      = parseInt(parts[0]);
  var month     = parseInt(parts[1]) - 1; // JS 0-indexed
  var daysInMon = new Date(year, month + 1, 0).getDate();

  // Collect results in memory — written in one batch API call at the end
  // instead of one write per day (reduces N sheet writes → 1).
  var pending = [];

  for (var d = 1; d <= daysInMon; d++) {
    var date    = new Date(year, month, d);
    var dateStr = Utilities.formatDate(date, tz, 'yyyy-MM-dd');

    if (dateStr >= today)       break;    // never process today/future
    if (existingDates[dateStr]) continue; // already done

    // Evaluate with the CURRENT in-memory counters (accurate sequencing)
    var punchLogs = DB_getPunchLogsForDate(employee.emp_id, dateStr);
    var result    = Policy_evaluateDay(employee, dateStr, punchLogs, holidayList, counters);

    if (!result || !result.status) continue;

    pending.push({
      emp_id           : employee.emp_id,
      date             : dateStr,
      in_time          : result.in_time,
      out_time         : result.out_time,
      status           : result.status,
      late_flag        : result.late_flag,
      early_flag       : result.early_flag,
      half_day_flag    : result.half_day_flag,
      working_sunday   : result.working_sunday,
      leave_credit_used: result.leave_credit_used,
      notes            : result.notes
    });

    // Update in-memory counters for the NEXT iteration
    counters.leave_credits_used += parseFloat(result.leave_credit_used) || 0;
    counters.late_early_used    += parseInt(result.late_early_delta)    || 0;
  }

  // Single batch write — N days become 1 Sheets API call
  if (pending.length > 0) {
    DB_batchAppendAttendanceSummary(pending);
  }

  Logger.log('Attendance_backfillMissingDays: ' + pending.length + ' new rows for ' + employee.emp_id + ' / ' + monthStr);
  return pending.length;
}


/**
 * Attendance_getExtraDaysYearly()
 *
 * PURPOSE: Sums "extra days earned" across a full calendar year for an
 *          employee. Extra days are earned by working on a Sunday or a
 *          public holiday (off days that the org normally pays for anyway).
 *
 * RULES (confirmed by org):
 *          Duration < 4 hrs        → +0.5 extra day
 *          Duration ≥ 4 hrs        → +1   extra day
 *          OUT punch missing       → +1   extra day  (still showed up)
 *
 * The computation is on-the-fly from ATTENDANCE_SUMMARY — no extra column,
 * no schema migration. Filters by status === Working Sunday | Working Holiday.
 *
 * @param  {string} empId
 * @param  {string} yearStr - "yyyy" (e.g. "2026")
 * @return {number} total extra days for the year
 */
function Attendance_getExtraDaysYearly(empId, yearStr) {
  // DB_getAttendanceSummaryForEmployee uses prefix match, so passing just
  // the year ("2026") returns ALL records for that year.
  var records = DB_getAttendanceSummaryForEmployee(empId, yearStr);
  var total   = 0;
  var WS      = CONFIG.STATUS.WORKING_SUNDAY;
  var WH      = CONFIG.STATUS.WORKING_HOLIDAY;

  records.forEach(function(r) {
    if (r.status !== WS && r.status !== WH) return;

    var inT  = r.in_time  ? _hhmmssToMinutes(r.in_time)  : null;
    var outT = r.out_time ? _hhmmssToMinutes(r.out_time) : null;

    if (inT === null && outT === null) return; // no times at all — skip

    // Missing OUT but has IN → user's rule: count as full day
    if (outT === null) { total += 1; return; }
    // Missing IN but has OUT (shouldn't happen but be safe)
    if (inT  === null) { total += 0.5; return; }

    var durationMin = outT - inT;
    if (durationMin >= 240) total += 1;     // ≥ 4 hrs
    else                    total += 0.5;   // < 4 hrs
  });

  return total;
}

/** Internal: "HH:MM" or "HH:MM:SS" → minutes from midnight. */
function _hhmmssToMinutes(timeStr) {
  if (!timeStr) return null;
  var parts = timeStr.toString().split(':');
  if (parts.length < 2) return null;
  var h = parseInt(parts[0]);
  var m = parseInt(parts[1]);
  if (isNaN(h) || isNaN(m)) return null;
  return h * 60 + m;
}


// =============================================================================
// FILE: LeaveService.gs (included here)
// PURPOSE: Leave request submission and admin actions.
//          IMPORTANT: Leave form is INFORMATION ONLY.
//          It does NOT change attendance or salary calculation.
//          Both Fixed and Probation employees can submit leave requests.
//          All functions prefixed "Leave_"
// =============================================================================

/**
 * Leave_submitRequest()
 * PURPOSE: Employee submits a leave request form.
 *          The form informs admin of planned absence in advance.
 *          Does NOT affect salary deductions — those follow allowance rules only.
 *
 * @param  {Object} formData       - all form fields
 * @param  {string} proofBase64    - optional base64 file data
 * @param  {string} proofFileName  - optional file name
 * @return {Object} { success, message, request_id }
 */
function Leave_submitRequest(formData, proofBase64, proofFileName) {
  try {
    var email = Auth_getCurrentEmail();
    var emp   = DB_getEmployeeByEmail(email);
    if (!emp) {
      return { success: false, message: 'You are not registered as an employee.' };
    }

    // Both Fixed AND Probation can submit leave requests
    // (no restriction — it's just information for admin)

    // Upload proof to Google Drive if configured and file provided
    var proofLink = '';
    if (proofBase64 && proofFileName && CONFIG.LEAVE_PROOF_FOLDER_ID) {
      proofLink = Leave_uploadProof(proofBase64, proofFileName, emp.emp_id);
    } else if (formData.proof_description) {
      proofLink = 'Note: ' + formData.proof_description;
    }

    return DB_saveLeaveRequest({
      emp_id       : emp.emp_id,
      name         : emp.name,
      leave_from   : formData.leave_from,
      leave_to     : formData.leave_to,
      request_type : formData.request_type,
      reason       : formData.reason,
      approved_by  : formData.approved_by,
      proof_link   : proofLink
    });

  } catch(e) {
    Logger.log('Leave_submitRequest ERROR: ' + e.message);
    return { success: false, message: 'Error: ' + e.message };
  }
}

/**
 * Leave_uploadProof()
 * PURPOSE: Uploads base64 image to Google Drive. Returns file URL.
 *
 * SHARING STRATEGY:
 *   1. Try "Anyone with link" public sharing (works for personal Gmail accounts)
 *   2. If domain policy blocks public sharing → share directly with every
 *      admin email from the ADMIN sheet so they can always view the file
 *   3. File creation and sharing are in SEPARATE try-catch blocks so a
 *      sharing failure never prevents the real URL from being stored.
 *
 * @param  {string} base64Data
 * @param  {string} fileName
 * @param  {string} empId
 * @return {string} Google Drive URL, or empty string on total failure
 */
function Leave_uploadProof(base64Data, fileName, empId) {
  try {
    var folderId = CONFIG.LEAVE_PROOF_FOLDER_ID;
    if (!folderId) return '';

    // ── Step 1: Create the file ───────────────────────────────────────────
    var folder  = DriveApp.getFolderById(folderId);
    var raw     = base64Data.split(',')[1] || base64Data;
    var decoded = Utilities.base64Decode(raw);
    var blob    = Utilities.newBlob(decoded, 'image/jpeg', empId + '_' + Date.now() + '_' + fileName);
    var file    = folder.createFile(blob);
    var fileUrl = file.getUrl(); // capture URL immediately after creation

    // ── Step 2: Make it viewable — try public first, fallback to admin emails
    //    These are in their own try-catch so a sharing error NEVER overwrites
    //    fileUrl with an error string.
    try {
      // Works for personal Gmail accounts and orgs that allow public sharing
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    } catch(shareErr) {
      Logger.log('Leave_uploadProof: Public sharing blocked — sharing with admins directly. ' + shareErr.message);
      // Fallback: share individually with every admin email
      try {
        var adminSheet = DB_getOrCreateSheet(CONFIG.SHEETS.ADMIN);
        var adminData  = adminSheet.getDataRange().getValues();
        for (var i = 1; i < adminData.length; i++) {
          var adminEmail = adminData[i][0] ? adminData[i][0].toString().trim() : '';
          if (adminEmail) file.addViewer(adminEmail);
        }
      } catch(adminErr) {
        Logger.log('Leave_uploadProof: Could not share with admins — ' + adminErr.message);
        // File still exists in Drive folder; admin can open it from the folder directly
      }
    }

    return fileUrl; // always the real Drive URL, never an error string

  } catch(e) {
    Logger.log('Leave_uploadProof ERROR: ' + e.message);
    return ''; // return empty — frontend will fall back to description text
  }
}

/**
 * Leave_adminAction()
 * PURPOSE: Admin marks a leave request Approved or Rejected.
 *          This has NO effect on salary calculation — it's just for admin tracking.
 * @param  {string} requestId
 * @param  {string} status    - 'Approved' | 'Rejected'
 * @param  {string} adminNote
 * @return {Object} { success, message }
 */
function Leave_adminAction(requestId, status, adminNote) {
  if (!Auth_isAdmin(Auth_getCurrentEmail())) {
    return { success: false, message: 'Admin access only.' };
  }
  return DB_updateLeaveStatus(requestId, status, adminNote);
}


// =============================================================================
// FILE: ReportService.gs (included here)
// PURPOSE: Generates monthly rollup summaries from daily attendance records.
//          All functions prefixed "Report_"
// =============================================================================

/**
 * Report_generateMonthlySummary()
 * PURPOSE: Scans daily attendance summaries for a given month and
 *          builds the monthly rollup. Can run for all employees or one.
 *
 *          Also calculates the number of actual working days in the month
 *          (total days minus Sundays minus holidays).
 *
 * @param {string} monthStr - "yyyy-MM"
 * @param {string} empId    - optional, process only this employee
 */
function Report_generateMonthlySummary(monthStr, empId) {
  var employees   = empId ? [DB_getEmployeeById(empId)] : DB_getAllEmployees();
  var holidayList = DB_getHolidayList();
  var S           = CONFIG.STATUS;

  // Calculate working days in this month (reused for all employees)
  var workingDays = Report_countWorkingDays(monthStr, holidayList);

  employees.forEach(function(emp) {
    if (!emp) return;

    var daily = DB_getAttendanceSummaryForEmployee(emp.emp_id, monthStr);

    var totals = {
      emp_id               : emp.emp_id,
      month                : monthStr,
      working_days         : workingDays,
      total_present        : 0,
      total_late           : 0,
      total_early          : 0,
      total_half_days      : 0,
      total_absent         : 0,
      total_unpaid_absent  : 0,
      total_leaves_used    : 0,
      total_working_sundays: 0,
      late_early_used      : 0,
      leave_credits_used   : 0
    };

    daily.forEach(function(d) {
      var st = d.status || '';
      if (st === S.PRESENT)         totals.total_present++;
      if (st === S.WORKING_SUNDAY)  { totals.total_present++; totals.total_working_sundays++; }
      if (st === S.HALF_DAY)        { totals.total_present++; totals.total_half_days++; }
      if (st === S.ABSENT)          totals.total_absent++;
      if (st === S.UNPAID_ABSENT)   { totals.total_absent++; totals.total_unpaid_absent++; }

      if (d.late_flag)              totals.total_late++;
      if (d.early_flag)             totals.total_early++;
      if (d.late_flag || d.early_flag) totals.late_early_used++;

      // Accumulate leave credits used (0, 0.5, or 1 per day)
      totals.leave_credits_used += (Number(d.leave_credit_used) || 0);
    });

    // total_leaves_used = full leave credits consumed
    // (2 half-day credits = 1 full leave in display terms)
    totals.total_leaves_used = totals.leave_credits_used;

    DB_saveMonthlySummary(totals);
  });

  Logger.log('Report_generateMonthlySummary: Done for ' + monthStr +
             (empId ? ' / ' + empId : ' (all)'));
}


/**
 * Report_countWorkingDays()
 * PURPOSE: Counts the actual working days in a given month.
 *          Excludes: weekly off days (Sundays) and public holidays.
 *          This is the denominator for attendance percentage.
 *
 * @param  {string}        monthStr    - "yyyy-MM"
 * @param  {Array<Object>} holidayList - from DB_getHolidayList()
 * @return {number} total working days
 */
function Report_countWorkingDays(monthStr, holidayList) {
  var parts     = monthStr.split('-');
  var year      = parseInt(parts[0]);
  var month     = parseInt(parts[1]) - 1; // JS months are 0-indexed
  var daysInMon = new Date(year, month + 1, 0).getDate();
  var tz        = Session.getScriptTimeZone();
  var count     = 0;

  for (var d = 1; d <= daysInMon; d++) {
    var date    = new Date(year, month, d);
    var dateStr = Utilities.formatDate(date, tz, 'yyyy-MM-dd');

    // Skip weekly off days
    if (Config_isWeeklyOff(date)) continue;

    // Skip public holidays
    if (DB_isHoliday(dateStr, holidayList)) continue;

    count++;
  }
  return count;
}


/**
 * Report_runMonthlyTrigger()
 * PURPOSE: Triggered on the 1st of each month to finalise last month's report.
 *          Attach to a monthly time-driven trigger.
 */
function Report_runMonthlyTrigger() {
  var tz   = Session.getScriptTimeZone();
  var now  = new Date();
  var last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  var mon  = Utilities.formatDate(last, tz, 'yyyy-MM');
  Report_generateMonthlySummary(mon);
  Logger.log('Report_runMonthlyTrigger: Monthly report generated for ' + mon);
}