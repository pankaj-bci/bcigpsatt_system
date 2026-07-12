// =============================================================================
// FILE: Code.gs
// PURPOSE: Web app entry point and all server-side functions.
//
// DEPLOYMENT SETTINGS (CRITICAL):
//   Execute as:     User accessing the web app
//   Who has access: Anyone with Google Account
//
// WHY "Execute as: User accessing the web app":
//   This is the ONLY setting where Session.getActiveUser().getEmail()
//   returns the real email for ALL Google accounts in doGet().
//   With "Execute as: Me", external Gmail users always get empty email.
//
// IMPORTANT — SHARE THE GOOGLE SHEET:
//   Since the script runs as the visiting user (not you), the sheet
//   must be shared so any Google account can read/write it.
//   Go to your Google Sheet → Share → Anyone with the link → Editor
//   This does NOT make it public — only people with the exact link can access it.
//   The app code still enforces who is admin and who is employee.
// =============================================================================


// =============================================================================
// WEB APP ENTRY POINT
// =============================================================================

/**
 * doGet()
 * PURPOSE: Detects email, routes admin to Admin.html, employee to Frontend.html.
 *          Works correctly because "Execute as: User accessing the web app"
 *          makes Session.getActiveUser().getEmail() return the real email.
 */
function doGet() {
  try {
    initializeDatabase();

    var email = Session.getActiveUser().getEmail();

    // Cannot detect email
    if (!email || email.trim().length === 0) {
      return _pageSignIn();
    }

    email = email.trim().toLowerCase();

    // Admin → Admin Dashboard
    if (Auth_isAdmin(email)) {
      return HtmlService
        .createTemplateFromFile('Admin')
        .evaluate()
        .setTitle('Admin — GPS Attendance')
        .addMetaTag('viewport', 'width=device-width,initial-scale=1');
    }

    // Registered employee → Staff page
    var emp = DB_getEmployeeByEmail(email);
    if (emp) {
      return HtmlService
        .createTemplateFromFile('Frontend')
        .evaluate()
        .setTitle('GPS Attendance')
        .addMetaTag('viewport', 'width=device-width,initial-scale=1');
    }

    // Not registered
    return _pageAccessDenied(email);

  } catch(err) {
    Logger.log('doGet ERROR: ' + err.message);
    return HtmlService.createHtmlOutput(
      '<div style="font-family:sans-serif;padding:30px;color:red;">' +
      '<h2>Startup Error</h2><p>' + err.message + '</p>' +
      '<p>Please contact your administrator.</p></div>'
    );
  }
}

// ── Error pages ────────────────────────────────────────────────────────────

function _pageSignIn() {
  return HtmlService.createHtmlOutput(
    '<!DOCTYPE html><html><head>' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>' +
    'body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0d1117;' +
    'color:#e6edf3;margin:0;min-height:100vh;display:flex;align-items:center;' +
    'justify-content:center;padding:20px;}' +
    '.box{background:#161b22;border:1px solid rgba(255,255,255,.1);border-radius:18px;' +
    'padding:44px 28px;text-align:center;max-width:340px;width:100%;}' +
    '.icon{font-size:52px;margin-bottom:16px;display:block}' +
    'h2{font-size:20px;margin-bottom:10px}' +
    'p{color:#7d8590;font-size:13px;line-height:1.6;margin-bottom:22px}' +
    'a{display:inline-block;background:#388bfd;color:#fff;padding:13px 32px;' +
    'border-radius:10px;text-decoration:none;font-weight:700;font-size:14px}' +
    '</style></head><body>' +
    '<div class="box">' +
    '<span class="icon">🔐</span>' +
    '<h2>Sign In Required</h2>' +
    '<p>Please sign in with your Google account to access the attendance system.</p>' +
    '<a href="javascript:window.location.reload()">Reload & Sign In</a>' +
    '</div></body></html>'
  ).setTitle('Sign In');
}

function _pageAccessDenied(email) {
  return HtmlService.createHtmlOutput(
    '<!DOCTYPE html><html><head>' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<style>' +
    'body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0d1117;' +
    'color:#e6edf3;margin:0;min-height:100vh;display:flex;align-items:center;' +
    'justify-content:center;padding:20px;}' +
    '.box{background:#161b22;border:1px solid rgba(255,255,255,.1);border-radius:18px;' +
    'padding:44px 28px;text-align:center;max-width:340px;width:100%;}' +
    '.icon{font-size:52px;margin-bottom:16px;display:block}' +
    'h2{font-size:20px;margin-bottom:10px}' +
    'p{color:#7d8590;font-size:13px;line-height:1.7;margin-bottom:10px}' +
    '.email{background:#1c2128;border-radius:10px;padding:12px;font-size:13px;' +
    'color:#388bfd;word-break:break-all;margin:14px 0;border:1px solid rgba(56,139,253,.2);}' +
    '</style></head><body>' +
    '<div class="box">' +
    '<span class="icon">⛔</span>' +
    '<h2>Access Denied</h2>' +
    '<p>Your email is not registered in this system.</p>' +
    '<div class="email">' + email + '</div>' +
    '<p>Please share the above email with your administrator to get registered.</p>' +
    '</div></body></html>'
  ).setTitle('Access Denied');
}


// =============================================================================
// AUTH HELPER
// =============================================================================

function Auth_isAdmin(email) {
  try {
    var sheet = DB_getOrCreateSheet(CONFIG.SHEETS.ADMIN);
    var data  = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (data[i][0] &&
          data[i][0].toString().trim().toLowerCase() === email.trim().toLowerCase()) {
        return true;
      }
    }
    return false;
  } catch(e) {
    Logger.log('Auth_isAdmin ERROR: ' + e.message);
    return false;
  }
}

function Auth_getCurrentEmail() {
  return Session.getActiveUser().getEmail().toLowerCase().trim();
}


// =============================================================================
// SERVER FUNCTIONS — USER INFO
// =============================================================================

function Server_getUserInfo() {
  try {
    var email = Auth_getCurrentEmail();
    if (!email) return { success: false, error: 'Email not detected.' };
    return {
      success  : true,
      email    : email,
      isAdmin  : Auth_isAdmin(email),
      employee : DB_getEmployeeByEmail(email)
    };
  } catch(e) { return { success: false, error: e.message }; }
}


// =============================================================================
// SERVER FUNCTIONS — PUNCH
// =============================================================================

function Server_recordPunch(action, lat, lon, accuracy, locationId) {
  try {
    return Attendance_processPunch(Auth_getCurrentEmail(), action, lat, lon, accuracy, locationId || null);
  } catch(e) { return { success: false, message: 'Server error: ' + e.message }; }
}

function Server_getMyLastPunch() {
  try {
    var emp = DB_getEmployeeByEmail(Auth_getCurrentEmail());
    if (!emp) return { success: false, message: 'Not registered.' };
    var last = DB_getLastPunchLog(emp.emp_id);
    return {
      success    : true,
      lastAction : last ? last.action   : null,
      lastTime   : last ? last.datetime : null
    };
  } catch(e) { return { success: false, error: e.message }; }
}


// =============================================================================
// SERVER FUNCTIONS — DASHBOARD
// =============================================================================

function Server_getMyDashboard(monthStr) {
  try {
    var email = Auth_getCurrentEmail();
    var emp   = DB_getEmployeeByEmail(email);
    if (!emp) return { success: false, message: 'Not registered.' };

    var tz  = Session.getScriptTimeZone();
    var mon = monthStr || Utilities.formatDate(new Date(), tz, 'yyyy-MM');

    // Backfill any past days with no record (handles newly added employees
    // or days the nightly trigger hasn't run yet)
    Attendance_backfillMissingDays(emp, mon);

    Report_generateMonthlySummary(mon, emp.emp_id);
    var holidayList = DB_getHolidayList();
    var year        = mon.substring(0, 4);
    var extraDays   = Attendance_getExtraDaysYearly(emp.emp_id, year);

    return {
      success       : true,
      employee      : emp,
      monthly       : DB_getMonthlySummary(emp.emp_id, mon),
      daily         : DB_getAttendanceSummaryForEmployee(emp.emp_id, mon),
      currentMonth  : mon,
      currentYear   : year,
      workingDays   : Report_countWorkingDays(mon, holidayList),
      holidayList   : holidayList,
      extraDaysYear : extraDays
    };
  } catch(e) { return { success: false, error: e.message }; }
}


// =============================================================================
// SERVER FUNCTIONS — LEAVE
// =============================================================================

function Server_submitLeave(formData, proofBase64, proofFileName) {
  try { return Leave_submitRequest(formData, proofBase64, proofFileName); }
  catch(e) { return { success: false, message: e.message }; }
}

function Server_getMyLeaveRequests() {
  try {
    var emp = DB_getEmployeeByEmail(Auth_getCurrentEmail());
    if (!emp) return { success: false, message: 'Not registered.' };
    return { success: true, data: DB_getLeaveRequestsForEmployee(emp.emp_id) };
  } catch(e) { return { success: false, error: e.message }; }
}

function Server_getLeaveFormConfig() {
  return {
    success   : true,
    approvers : CONFIG.LEAVE_APPROVERS,
    reasons   : CONFIG.LEAVE_REASONS,
    types     : CONFIG.LEAVE_TYPES
  };
}


// =============================================================================
// SERVER FUNCTIONS — ADMIN EMPLOYEES
// =============================================================================

function Server_addEmployee(data) {
  try {
    if (!Auth_isAdmin(Auth_getCurrentEmail())) return { success: false, message: 'Admin only.' };
    return DB_saveEmployee(data);
  } catch(e) { return { success: false, message: e.message }; }
}

function Server_updateEmployee(empId, updates) {
  try {
    if (!Auth_isAdmin(Auth_getCurrentEmail())) return { success: false, message: 'Admin only.' };
    return DB_updateEmployee(empId, updates);
  } catch(e) { return { success: false, message: e.message }; }
}

function Server_getAllEmployees() {
  try {
    if (!Auth_isAdmin(Auth_getCurrentEmail())) return { success: false, message: 'Admin only.' };
    return { success: true, data: DB_getAllEmployees() };
  } catch(e) { return { success: false, message: e.message }; }
}


// =============================================================================
// SERVER FUNCTIONS — ADMIN LOCATIONS
// =============================================================================

function Server_addLocation(data) {
  try {
    if (!Auth_isAdmin(Auth_getCurrentEmail())) return { success: false, message: 'Admin only.' };
    return DB_saveLocation(data);
  } catch(e) { return { success: false, message: e.message }; }
}

function Server_getAllLocations() {
  try { return { success: true, data: DB_getAllLocations() }; }
  catch(e) { return { success: false, message: e.message }; }
}


// =============================================================================
// SERVER FUNCTIONS — ADMIN HOLIDAYS
// =============================================================================

function Server_getHolidayList() {
  try { return { success: true, data: DB_getHolidayList() }; }
  catch(e) { return { success: false, message: e.message }; }
}

function Server_addHoliday(dateStr, holidayName) {
  try {
    if (!Auth_isAdmin(Auth_getCurrentEmail())) return { success: false, message: 'Admin only.' };
    return DB_saveHoliday(dateStr, holidayName);
  } catch(e) { return { success: false, message: e.message }; }
}

function Server_deleteHoliday(dateStr) {
  try {
    if (!Auth_isAdmin(Auth_getCurrentEmail())) return { success: false, message: 'Admin only.' };
    return DB_deleteHoliday(dateStr);
  } catch(e) { return { success: false, message: e.message }; }
}


// =============================================================================
// SERVER FUNCTIONS — ADMIN REPORTS
// =============================================================================

function Server_getAdminReport(empId, monthStr) {
  try {
    if (!Auth_isAdmin(Auth_getCurrentEmail())) return { success: false, message: 'Admin only.' };

    var tz  = Session.getScriptTimeZone();
    var mon = monthStr || Utilities.formatDate(new Date(), tz, 'yyyy-MM');

    // Backfill missing days. Track which employees got new rows so we only
    // regenerate their monthly summary — skipping it for employees whose data
    // is already complete keeps the steady-state admin report fast.
    var empsToBackfill  = empId ? [DB_getEmployeeById(empId)] : DB_getAllEmployees();
    var empsWithNewRows = [];
    empsToBackfill.forEach(function(emp) {
      if (emp && emp.emp_id && emp.status === 'Active') {
        if (Attendance_backfillMissingDays(emp, mon) > 0) {
          empsWithNewRows.push(emp.emp_id);
        }
      }
    });

    // Only recompute monthly summary for employees who had missing days;
    // the nightly trigger keeps everyone else's summary current.
    empsWithNewRows.forEach(function(id) {
      Report_generateMonthlySummary(mon, id);
    });

    var holidayList = DB_getHolidayList();
    var year        = mon.substring(0, 4);

    // Build a map of emp_id → yearly extra days for the admin report
    var extraDaysMap = {};
    var empsForExtra = empId ? [DB_getEmployeeById(empId)] : DB_getAllEmployees();
    empsForExtra.forEach(function(emp) {
      if (emp && emp.emp_id) {
        extraDaysMap[emp.emp_id] = Attendance_getExtraDaysYearly(emp.emp_id, year);
      }
    });

    return {
      success      : true,
      daily        : DB_getAttendanceSummaryAll(empId || null, mon),
      monthly      : DB_getAllMonthlySummaries(empId || null, mon),
      leaves       : DB_getAllLeaveRequests(empId || null, null),
      employees    : DB_getAllEmployees(),
      holidayList  : holidayList,
      workingDays  : Report_countWorkingDays(mon, holidayList),
      month        : mon,
      year         : year,
      extraDaysMap : extraDaysMap
    };
  } catch(e) { return { success: false, message: e.message }; }
}

function Server_getAllPunchLogs() {
  try {
    if (!Auth_isAdmin(Auth_getCurrentEmail())) return { success: false, message: 'Admin only.' };
    return { success: true, data: DB_getAllPunchLogs() };
  } catch(e) { return { success: false, message: e.message }; }
}

/**
 * Server_getTodayPunchLogs()
 * Returns only TODAY's punch logs, enriched with employee name. Fast (today only).
 */
function Server_getTodayPunchLogs() {
  try {
    if (!Auth_isAdmin(Auth_getCurrentEmail())) return { success: false, message: 'Admin only.' };
    var logs = DB_getPunchLogsForAllToday();
    var emps = DB_getAllEmployees();
    var nameById = {};
    emps.forEach(function(e) { nameById[e.emp_id] = e.name; });
    logs.forEach(function(l) { l.name = nameById[l.emp_id] || l.emp_id; });
    return { success: true, data: logs };
  } catch(e) { return { success: false, message: e.message }; }
}

/**
 * Server_getTodayDashboard()
 * ============================================================
 * The LIVE "Today" dashboard for admin. Computes the current state of every
 * active employee purely by READING today's punch logs + today's leaves.
 * It NEVER writes to the sheet — the nightly trigger still does official
 * attendance marking. This is a pure live VIEW.
 *
 * Returns 8 tile counts + the list of employee names in each tile so the
 * frontend can show expandable lists.
 *
 * Tile logic per active employee (skipping holidays / Sundays):
 *   • On Leave    → has Approved/Pending leave covering today
 *   • Present     → has at least one IN punch today
 *       • Late        → first IN punch is after grace deadline
 *       • In Office   → first IN punch location ≈ head office (L1)
 *       • In Workshop → first IN punch location ≈ any other location
 *   • Absent      → no IN punch AND current time is past grace deadline
 *   • Yet to Punch→ no IN punch AND current time is before grace deadline
 * ============================================================
 */
function Server_getTodayDashboard() {
  try {
    if (!Auth_isAdmin(Auth_getCurrentEmail())) return { success: false, message: 'Admin only.' };

    var tz       = Session.getScriptTimeZone();
    var now      = new Date();
    var today    = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
    var nowMin   = now.getHours() * 60 + now.getMinutes();

    // Grace deadline = shift start + 6 min grace (matches both Fixed ON_TIME_MAX
    // and Probation LATE_THRESHOLD). This is a live VIEW threshold; the official
    // per-employee policy still runs in the nightly trigger.
    var graceMins = (CONFIG.FIXED && CONFIG.FIXED.ON_TIME_MAX_MINUTES != null)
                    ? CONFIG.FIXED.ON_TIME_MAX_MINUTES : 6;
    var graceMin  = Config_shiftStartMinutes() + graceMins;

    // Is today a holiday or Sunday? Then nobody is "absent".
    var holidayList = DB_getHolidayList();
    var isHoliday   = !!DB_isHoliday(today, holidayList);
    var isSunday    = (now.getDay() === 0);
    var isOffDay    = isHoliday || isSunday;

    // Load everything we need (all cached or today-scoped → fast)
    var employees = DB_getAllEmployees().filter(function(e) { return e.status === 'Active'; });
    var todayLogs = DB_getPunchLogsForAllToday();          // today only
    var locations = DB_getAllLocations();                  // cached
    var officeId  = CONFIG.OFFICE_LOCATION.location_id;     // 'L1'
    var leaves    = DB_getLeaveRequestsForToday(['Approved', 'Pending']);

    // Map: emp_id → earliest IN punch today
    var firstInByEmp = {};
    todayLogs.forEach(function(l) {
      if (l.action !== 'IN') return;
      if (!firstInByEmp[l.emp_id] || l.datetime < firstInByEmp[l.emp_id].datetime) {
        firstInByEmp[l.emp_id] = l;
      }
    });

    // Set of emp_ids on leave today
    var onLeaveSet = {};
    leaves.forEach(function(lv) { onLeaveSet[lv.emp_id] = lv.status; });

    // Helper: which location is this punch nearest to (within radius)?
    function resolveLocation(lat, lon) {
      for (var i = 0; i < locations.length; i++) {
        var loc = locations[i];
        var d = Loc_haversineDistance(lat, lon, loc.latitude, loc.longitude);
        if (d <= (loc.radius || 100)) return loc.location_id;
      }
      return null; // not within any known location radius
    }

    // Helper: "HH:mm:ss" → minutes from midnight
    function punchMinutes(dtStr) {
      // dtStr = "yyyy-MM-dd HH:mm:ss"
      var t = dtStr.split(' ')[1];
      if (!t) return null;
      var p = t.split(':');
      return parseInt(p[0]) * 60 + parseInt(p[1]);
    }

    // Build the tiles
    var tiles = {
      total_staff  : { count: 0, names: [] },
      present      : { count: 0, names: [] },
      absent       : { count: 0, names: [] },
      late         : { count: 0, names: [] },
      on_leave     : { count: 0, names: [] },
      in_office    : { count: 0, names: [] },
      in_workshop  : { count: 0, names: [] },
      in_wfh       : { count: 0, names: [] },
      in_other     : { count: 0, names: [] },
      yet_to_punch : { count: 0, names: [] }
    };

    function add(tile, name) { tiles[tile].count++; tiles[tile].names.push(name); }

    employees.forEach(function(e) {
      add('total_staff', e.name);

      // On leave takes priority
      if (onLeaveSet[e.emp_id]) {
        add('on_leave', e.name + (onLeaveSet[e.emp_id] === 'Pending' ? ' (Pending)' : ''));
        return;
      }

      var firstIn = firstInByEmp[e.emp_id];

      if (firstIn) {
        // Present
        add('present', e.name);

        // Late?
        var pm = punchMinutes(firstIn.datetime);
        if (pm !== null && pm > graceMin) add('late', e.name);

        // Location bucket: read stored locationType for new punches;
        // fall back to GPS resolution for old records that predate the field.
        var lt = firstIn.locationType || '';
        if      (lt === 'HEAD_OFFICE') { add('in_office',   e.name); }
        else if (lt === 'WFH')         { add('in_wfh',      e.name); }
        else if (lt === 'OTHER')       { add('in_other',    e.name); }
        else if (lt === 'WORKSHOP')    { add('in_workshop', e.name); }
        else {
          // Old record with no locationType — resolve by GPS
          var locId = resolveLocation(parseFloat(firstIn.latitude), parseFloat(firstIn.longitude));
          if (locId === officeId) add('in_office',   e.name);
          else                    add('in_workshop', e.name);
        }

      } else {
        // No IN punch yet
        if (isOffDay) {
          // Off day — don't count as absent; treat neutrally
          // (we simply don't add them anywhere except total_staff)
        } else if (nowMin > graceMin) {
          add('absent', e.name);
        } else {
          add('yet_to_punch', e.name);
        }
      }
    });

    return {
      success    : true,
      date       : today,
      isOffDay   : isOffDay,
      offReason  : isHoliday ? 'Holiday' : (isSunday ? 'Sunday' : ''),
      asOf       : Utilities.formatDate(now, tz, 'HH:mm:ss'),
      tiles      : tiles
    };

  } catch(e) {
    return { success: false, message: e.message };
  }
}

function Server_adminLeaveAction(requestId, status, note) {
  try { return Leave_adminAction(requestId, status, note); }
  catch(e) { return { success: false, message: e.message }; }
}

function Server_getAllLeaveRequests(empId, statusFilter) {
  try {
    if (!Auth_isAdmin(Auth_getCurrentEmail())) return { success: false, message: 'Admin only.' };
    return { success: true, data: DB_getAllLeaveRequests(empId || null, statusFilter || null) };
  } catch(e) { return { success: false, message: e.message }; }
}

/**
 * Server_getTodayLeaveRequests()
 * Returns leave requests covering today (Approved + Pending). Fast, scoped.
 * Used as the DEFAULT view of the Leave Requests tab.
 */
function Server_getTodayLeaveRequests() {
  try {
    if (!Auth_isAdmin(Auth_getCurrentEmail())) return { success: false, message: 'Admin only.' };
    return { success: true, data: DB_getLeaveRequestsForToday(['Approved', 'Pending']) };
  } catch(e) { return { success: false, message: e.message }; }
}


// =============================================================================
// TRIGGERS
// =============================================================================

/**
 * Attendance_warmupTrigger()
 *
 * PURPOSE: Keeps the Apps Script container "warm" during work hours so that
 *          staff requests don't suffer cold-start delays.
 *
 * HOW IT WORKS:
 *   • Runs every 5 minutes (set up via setupTriggers).
 *   • Only "works" Mon–Sat, 8 AM – 8 PM (Asia/Kolkata).
 *   • Outside work hours → returns immediately (no waste of quota).
 *   • Inside work hours → executes a tiny no-op, which alone is enough
 *     to keep the script container hot in Google's infrastructure.
 *
 * QUOTA IMPACT: ~144 brief executions per work day × ~0.2s each ≈ 30s/day.
 *               Well within Apps Script's daily limits.
 */
function Attendance_warmupTrigger() {
  try {
    var now    = new Date();
    var hour   = now.getHours();
    var day    = now.getDay();   // 0=Sun, 1=Mon, ... 6=Sat

    // Skip Sunday entirely
    if (day === 0) return;
    // Skip outside 8:00–20:00
    if (hour < 8 || hour >= 20) return;

    // Inside work hours — touch a cheap operation to keep things warm.
    // Reading from CacheService is the lightest "real work" we can do.
    var cache = CacheService.getScriptCache();
    cache.put('warmup_lastrun', now.toISOString(), 600);

  } catch(e) {
    // Never let warmup crash the project — log and move on
    Logger.log('Attendance_warmupTrigger: ' + e.message);
  }
}


function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(function(t) { ScriptApp.deleteTrigger(t); });

  // Daily attendance trigger — runs every night at 11 PM
  ScriptApp.newTrigger('Attendance_runDailyTrigger')
    .timeBased().everyDays(1).atHour(23).create();

  // Monthly summary trigger — runs 1st of every month at 1 AM
  ScriptApp.newTrigger('Report_runMonthlyTrigger')
    .timeBased().onMonthDay(1).atHour(1).create();

  // Warm-up trigger — fires every 5 minutes, the function itself filters by hour/day
  ScriptApp.newTrigger('Attendance_warmupTrigger')
    .timeBased().everyMinutes(5).create();

  Logger.log('setupTriggers: All 3 triggers created (daily, monthly, warmup).');
}